import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LogEvent, LogFilters } from "./model";

export interface LogStore {
  insert(events: LogEvent[]): void;
  query(filters: LogFilters): { logs: LogEvent[]; nextCursor: string | null };
  get(id: string): LogEvent | null;
  trace(traceId: string): LogEvent[];
  removeBefore(timestamp: string): number;
  count(): number;
  projects(): string[];
  services(project: string): string[];
  close(): void;
}

interface Cursor {
  timestamp: string;
  id: string;
}

function parseCursor(cursor: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Cursor;
    if (typeof parsed.timestamp === "string" && typeof parsed.id === "string") return parsed;
  } catch {
    return null;
  }
  return null;
}

function event(row: Record<string, string | null>): LogEvent {
  return {
    id: row.id!,
    project: row.project!,
    timestamp: row.timestamp!,
    level: row.level as LogEvent["level"],
    message: row.message!,
    service: row.service!,
    environment: row.environment!,
    traceId: row.trace_id,
    requestId: row.request_id,
    host: row.host,
    source: row.source,
    metadata: JSON.parse(row.metadata || "{}") as Record<string, unknown>,
  };
}

export class SQLiteLogStore implements LogStore {
  readonly database: Database;

  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.database = new Database(filename, { create: true });
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        project TEXT NOT NULL,
        environment TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL DEFAULT 'default',
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        service TEXT NOT NULL,
        environment TEXT NOT NULL,
        trace_id TEXT,
        request_id TEXT,
        host TEXT,
        source TEXT,
        metadata TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS logs_timestamp_id ON logs(timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS logs_project_timestamp ON logs(project, timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS logs_service_timestamp ON logs(service, timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS logs_level_timestamp ON logs(level, timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS logs_trace_timestamp ON logs(trace_id, timestamp, id);
      CREATE INDEX IF NOT EXISTS logs_environment_timestamp ON logs(environment, timestamp DESC, id DESC);
    `);
  }

  insert(events: LogEvent[]): void {
    const insert = this.database.prepare(`INSERT INTO logs
      (id, project, timestamp, level, message, service, environment, trace_id, request_id, host, source, metadata)
      VALUES ($id, $project, $timestamp, $level, $message, $service, $environment, $trace_id, $request_id, $host, $source, $metadata)`);
    const transaction = this.database.transaction((rows: LogEvent[]) => {
      for (const log of rows) {
        insert.run({
          $id: log.id, $project: log.project, $timestamp: log.timestamp, $level: log.level, $message: log.message,
          $service: log.service, $environment: log.environment, $trace_id: log.traceId,
          $request_id: log.requestId, $host: log.host, $source: log.source, $metadata: JSON.stringify(log.metadata),
        });
      }
    });
    transaction(events);
  }

  query(filters: LogFilters): { logs: LogEvent[]; nextCursor: string | null } {
    const where: string[] = [];
    const bindings: Record<string, string | number> = {};
    const add = (column: string, key: string, value: string | undefined) => {
      if (value !== undefined) {
        where.push(`${column} = $${key}`);
        bindings[`$${key}`] = value;
      }
    };
    add("level", "level", filters.level);
    add("project", "project", filters.project);
    add("service", "service", filters.service);
    add("environment", "environment", filters.environment);
    add("trace_id", "trace_id", filters.traceId);
    add("request_id", "request_id", filters.requestId);
    if (filters.from) { where.push("timestamp >= $from"); bindings.$from = filters.from; }
    if (filters.to) { where.push("timestamp <= $to"); bindings.$to = filters.to; }
    if (filters.search) { where.push("instr(lower(message), lower($search)) > 0"); bindings.$search = filters.search; }
    if (filters.cursor) {
      const cursor = parseCursor(filters.cursor);
      if (!cursor) throw new Error("Invalid cursor");
      where.push("(timestamp < $cursor_timestamp OR (timestamp = $cursor_timestamp AND id < $cursor_id))");
      bindings.$cursor_timestamp = cursor.timestamp;
      bindings.$cursor_id = cursor.id;
    }
    const sql = `SELECT * FROM logs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY timestamp DESC, id DESC LIMIT $limit`;
    const rows = this.database.query(sql).all({ ...bindings, $limit: filters.limit + 1 }) as Record<string, string | null>[];
    const hasMore = rows.length > filters.limit;
    const logs = rows.slice(0, filters.limit).map(event);
    const last = logs.at(-1);
    return {
      logs,
      nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ timestamp: last.timestamp, id: last.id })).toString("base64url") : null,
    };
  }

  get(id: string): LogEvent | null {
    const row = this.database.query("SELECT * FROM logs WHERE id = ?").get(id) as Record<string, string | null> | null;
    return row ? event(row) : null;
  }

  trace(traceId: string): LogEvent[] {
    return (this.database.query("SELECT * FROM logs WHERE trace_id = ? ORDER BY timestamp, id").all(traceId) as Record<string, string | null>[]).map(event);
  }

  removeBefore(timestamp: string): number {
    return this.database.query("DELETE FROM logs WHERE timestamp < ?").run(timestamp).changes;
  }

  count(): number {
    return (this.database.query("SELECT count(*) AS count FROM logs").get() as { count: number }).count;
  }

  projects(): string[] {
    return (this.database.query("SELECT DISTINCT project FROM logs ORDER BY project").all() as Array<{ project: string }>).map((row) => row.project);
  }

  services(project: string): string[] {
    return (this.database.query("SELECT DISTINCT service FROM logs WHERE project = ? ORDER BY service").all(project) as Array<{ service: string }>).map((row) => row.service);
  }

  close(): void {
    this.database.close();
  }
}

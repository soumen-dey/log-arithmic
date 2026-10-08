import type { Config } from "./config";
import type { EventBus } from "./event-bus";
import { constantTimeEqual, KeyManager, type KeyScope } from "./auth";
import type { LogEvent, LogFilters, LogLevel } from "./model";
import { LOG_LEVELS } from "./model";
import { normalizeLog, ValidationError } from "./normalize";
import type { LogStore } from "./store";

interface RateWindow {
  start: number;
  count: number;
}

const encoder = new TextEncoder();

class PayloadTooLargeError extends Error {}

async function readLimitedBody(request: Request, maximumBytes: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new PayloadTooLargeError("Request body exceeds configured limit");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}

function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function parseFilters(url: URL, scope: KeyScope, maxLimit = 500): LogFilters {
  const params = url.searchParams;
  const level = params.get("level");
  if (level && !LOG_LEVELS.includes(level as LogLevel)) throw new ValidationError("Invalid level filter");
  const limit = Number(params.get("limit") || 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new ValidationError(`limit must be between 1 and ${maxLimit}`);
  }
  const from = params.get("from") || undefined;
  const to = params.get("to") || undefined;
  for (const [name, value] of [["from", from], ["to", to]] as const) {
    if (value && !Number.isFinite(Date.parse(value))) throw new ValidationError(`${name} must be a valid timestamp`);
  }
  return {
    project: scope.project,
    environment: scope.environment,
    from,
    to,
    level: level as LogLevel | undefined,
    service: params.get("service") || undefined,
    traceId: params.get("traceId") || undefined,
    requestId: params.get("requestId") || undefined,
    search: params.get("search") || undefined,
    cursor: params.get("cursor") || undefined,
    limit,
  };
}

function authSecret(request: Request): string | null {
  const value = request.headers.get("authorization");
  const match = value?.match(/^Bearer (.+)$/i);
  return match?.[1] || null;
}

export function createHandler(options: {
  config: Config;
  store: LogStore;
  keys: KeyManager;
  bus: EventBus;
  startedAt: number;
  counts: { ingested: number };
}) {
  const { config, store, keys, bus } = options;
  const windows = new Map<string, RateWindow>();
  let lastMinuteCount = 0;
  let lastMinuteAt = Date.now();

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const headers = new Headers({
      "Access-Control-Allow-Origin": config.corsOrigin,
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    try {
      const path = url.pathname;
      if (path === "/health" && request.method === "GET") return json({ status: "ok", uptimeSeconds: Math.floor((Date.now() - options.startedAt) / 1000) }, 200, headers);
      if (path === "/ready" && request.method === "GET") {
        store.count();
        return json({ status: "ready", database: "connected" }, 200, headers);
      }

      if (path.startsWith("/api/v1/keys")) {
        const supplied = authSecret(request) || "";
        if (!config.adminToken || !constantTimeEqual(supplied, config.adminToken)) {
          return json({ error: { code: "unauthorized", message: "Admin authorization required" } }, 401, headers);
        }
        if (path === "/api/v1/keys" && request.method === "POST") {
          const body = await request.json() as Record<string, unknown>;
          const project = body.project;
          const environment = body.environment || "production";
          if (typeof project !== "string" || !project.trim() || project.length > 128
            || typeof environment !== "string" || !environment.trim() || environment.length > 128) {
            throw new ValidationError("project and environment must be non-empty strings of at most 128 characters");
          }
          const created = keys.create(project.trim(), environment.trim());
          return json({ id: created.id, secret: created.secret, prefix: created.prefix, project: created.project, environment: created.environment, createdAt: created.createdAt }, 201, headers);
        }
        if (path === "/api/v1/keys" && request.method === "GET") return json({ keys: keys.list() }, 200, headers);
        const revoke = path.match(/^\/api\/v1\/keys\/([^/]+)$/);
        if (revoke && request.method === "DELETE") {
          return keys.revoke(decodeURIComponent(revoke[1]))
            ? new Response(null, { status: 204, headers })
            : json({ error: { code: "not_found", message: "Active API key not found" } }, 404, headers);
        }
      }

      const isIngest = path === "/api/v1/logs" || path === "/api/v1/logs/batch";
      const secret = authSecret(request);
      const scope = secret ? keys.authenticate(secret) : null;
      if (!scope) return json({ error: { code: "unauthorized", message: "Valid bearer API key required" } }, 401, headers);
      if (isIngest) {
        const now = Date.now();
        if (now - lastMinuteAt >= 60_000) {
          lastMinuteAt = now;
          lastMinuteCount = 0;
        }
        const identity = scope.id;
        let window = windows.get(identity);
        if (!window || now - window.start >= 60_000) {
          window = { start: now, count: 0 };
          windows.set(identity, window);
        }
        if (window.count >= config.rateLimit) {
          return json({ error: { code: "rate_limited", message: "Ingestion rate limit exceeded" } }, 429, { ...Object.fromEntries(headers), "Retry-After": "60" });
        }
        const declaredLength = Number(request.headers.get("content-length") || 0);
        if (declaredLength > config.maxRequestBytes) return json({ error: { code: "too_large", message: "Request body exceeds configured limit" } }, 413, headers);
        const rawBody = await readLimitedBody(request, config.maxRequestBytes);
        window.count += 1;
        let body: unknown;
        try { body = JSON.parse(rawBody); } catch { throw new ValidationError("Request body must contain valid JSON"); }
        const inputLogs = path.endsWith("/batch")
          ? (body as { logs?: unknown[] } | null)?.logs
          : [body];
        if (!Array.isArray(inputLogs) || inputLogs.length === 0) throw new ValidationError("Batch body must contain a non-empty logs array");
        if (inputLogs.length > config.maxBatchSize) return json({ error: { code: "batch_too_large", message: `Batch limit is ${config.maxBatchSize}` } }, 413, headers);
        const events = inputLogs.map((input) => normalizeLog(input, scope));
        if (events.some((item) => item.project !== scope.project || item.environment !== scope.environment)) {
          throw new ValidationError("Log project and environment must match the API key scope");
        }
        store.insert(events);
        options.counts.ingested += events.length;
        lastMinuteCount += events.length;
        bus.publish(events);
        return json({ accepted: events.length, ids: events.map((item) => item.id) }, path.endsWith("/batch") ? 202 : 201, headers);
      }

      if (path === "/api/v1/logs" && request.method === "GET") {
        return json(store.query(parseFilters(url, scope)), 200, headers);
      }
      if (path === "/api/v1/logs/export" && request.method === "GET") {
        const result = store.query({ ...parseFilters(url, scope, 5000), limit: 5000, cursor: undefined });
        const format = url.searchParams.get("format") || "json";
        if (format === "ndjson") {
          headers.set("Content-Type", "application/x-ndjson; charset=utf-8");
          return new Response(result.logs.map((item) => JSON.stringify(item)).join("\n"), { headers });
        }
        if (format === "csv") {
          const columns = ["id", "timestamp", "level", "project", "service", "environment", "message", "traceId", "requestId", "metadata"] as const;
          headers.set("Content-Type", "text/csv; charset=utf-8");
          const rows = result.logs.map((item) => columns.map((key) => csvCell(typeof item[key] === "string" ? item[key] as string : JSON.stringify(item[key] ?? ""))).join(","));
          return new Response([columns.join(","), ...rows].join("\n"), { headers });
        }
        if (format !== "json") throw new ValidationError("format must be json, ndjson, or csv");
        headers.set("Content-Disposition", 'attachment; filename="logforge-logs.json"');
        return json({ logs: result.logs, truncated: result.nextCursor !== null }, 200, headers);
      }
      const traceMatch = path.match(/^\/api\/v1\/traces\/([^/]+)$/);
      if (traceMatch && request.method === "GET") {
        const traceId = decodeURIComponent(traceMatch[1]);
        return json({ logs: store.trace(traceId).filter((item) => item.project === scope.project && item.environment === scope.environment) }, 200, headers);
      }
      const detailMatch = path.match(/^\/api\/v1\/logs\/([^/]+)$/);
      if (detailMatch && request.method === "GET") {
        const item = store.get(decodeURIComponent(detailMatch[1]));
        return item && item.project === scope.project && item.environment === scope.environment
          ? json(item, 200, headers)
          : json({ error: { code: "not_found", message: "Log not found" } }, 404, headers);
      }
      if (path === "/api/v1/stream" && request.method === "GET") {
        const filters = parseFilters(url, scope);
        let unsubscribe: (() => void) | undefined;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const cleanup = () => {
          unsubscribe?.();
          if (heartbeat) clearInterval(heartbeat);
          unsubscribe = undefined;
          heartbeat = undefined;
        };
        const stream = new ReadableStream<Uint8Array>({
          start(streamController) {
            controller = streamController;
            const send = (type: string, payload: unknown) => {
              if (!controller) return;
              if ((controller.desiredSize ?? 0) <= 0) {
                cleanup();
                controller.close();
                controller = undefined;
                return;
              }
              controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`));
            };
            unsubscribe = bus.subscribe(filters, (item) => send("log", item));
            send("ready", { connected: true });
            heartbeat = setInterval(() => send("heartbeat", { time: new Date().toISOString() }), 20_000);
          },
          cancel() {
            cleanup();
            controller = undefined;
          },
        }, { highWaterMark: 256 });
        headers.set("Content-Type", "text/event-stream; charset=utf-8");
        headers.set("Connection", "keep-alive");
        return new Response(stream, { headers });
      }
      if (path === "/api/v1/metrics" && request.method === "GET") {
        const now = Date.now();
        const elapsed = Math.max(1, now - lastMinuteAt) / 1000;
        const rate = lastMinuteCount / elapsed;
        return json({ totalLogs: store.count(), ingestedSinceStart: options.counts.ingested, ingestionRatePerSecond: rate, activeStreams: bus.subscriberCount, uptimeSeconds: Math.floor((now - options.startedAt) / 1000) }, 200, headers);
      }
      if (path === "/api/v1/projects" && request.method === "GET") {
        return json({ projects: [scope.project], services: store.services(scope.project) }, 200, headers);
      }
      return json({ error: { code: "not_found", message: "Route not found" } }, 404, headers);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return json({ error: { code: "too_large", message: error.message } }, 413, headers);
      }
      if (error instanceof ValidationError || (error instanceof Error && error.message === "Invalid cursor")) {
        return json({ error: { code: "invalid_request", message: error.message } }, 400, headers);
      }
      if (error instanceof SyntaxError) return json({ error: { code: "invalid_request", message: "Invalid JSON request body" } }, 400, headers);
      console.error("Request failed:", error);
      return json({ error: { code: "internal_error", message: "Request could not be completed" } }, 500, headers);
    }
  };
}

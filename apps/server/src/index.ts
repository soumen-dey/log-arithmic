import { loadConfig } from "./config";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { KeyManager } from "./auth";
import { InMemoryEventBus } from "./event-bus";
import { createHandler } from "./http";
import { SQLiteLogStore } from "./store";

const config = loadConfig();
if (!config.adminToken) {
  const tokenPath = config.database === ":memory:" ? "./.log-arithmic-admin-token" : `${config.database}.admin-token`;
  mkdirSync(dirname(tokenPath), { recursive: true });
  if (existsSync(tokenPath)) {
    config.adminToken = readFileSync(tokenPath, "utf8").trim();
  } else {
    const generated = randomBytes(32).toString("base64url");
    let descriptor: number | undefined;
    try {
      descriptor = openSync(tokenPath, "wx", 0o600);
      writeFileSync(descriptor, `${generated}\n`, "utf8");
      config.adminToken = generated;
      console.info(`Generated admin token stored at ${tokenPath}; read that file to manage project API keys.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      config.adminToken = readFileSync(tokenPath, "utf8").trim();
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  if (config.adminToken.length < 32) {
    throw new Error(`Admin token file ${tokenPath} must contain at least 32 characters`);
  }
}
const store = new SQLiteLogStore(config.database);
const keys = new KeyManager(store.database);
const bus = new InMemoryEventBus();
const startedAt = Date.now();
const counts = { ingested: 0 };
const handler = createHandler({ config, store, keys, bus, startedAt, counts });
let shuttingDown = false;
const retentionTimer = config.retentionDays === 0 ? undefined : setInterval(() => {
  try {
    const cutoff = new Date(Date.now() - config.retentionDays * 86_400_000).toISOString();
    const removed = store.removeBefore(cutoff);
    if (removed > 0) console.info(`Retention removed ${removed} expired log events`);
  } catch (error) {
    console.error("Retention cleanup failed:", error);
  }
}, 60 * 60 * 1000);

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  async fetch(request, server) {
    try {
      return await handler(request);
    } catch (error) {
      console.error("Unhandled request error:", error);
      return Response.json({ error: { code: "internal_error", message: "Request could not be completed" } }, { status: 500 });
    }
  },
  error(error) {
    console.error("HTTP server error:", error);
    return Response.json({ error: { code: "internal_error", message: "Request could not be completed" } }, { status: 500 });
  },
});

console.info(`Log Arithmic listening on http://${config.host}:${server.port}`);
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`${signal} received; shutting down Log Arithmic`);
  if (retentionTimer) clearInterval(retentionTimer);
  server.stop(true);
  store.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

import { describe, expect, test } from "bun:test";
import { KeyManager, constantTimeEqual } from "./auth";
import { loadConfig } from "./config";
import { InMemoryEventBus } from "./event-bus";
import { createHandler } from "./http";
import { normalizeLog, ValidationError } from "./normalize";
import { SQLiteLogStore } from "./store";

describe("configuration and normalization", () => {
  test("validates integer configuration and defaults", () => {
    const admin = "a".repeat(32);
    expect(loadConfig({ LOG_ARITHMIC_PORT: "9000", LOG_ARITHMIC_ADMIN_TOKEN: admin }).port).toBe(9000);
    expect(loadConfig({ LOGFORGE_PORT: "9001", LOGFORGE_ADMIN_TOKEN: admin }).port).toBe(9001);
    expect(() => loadConfig({ LOG_ARITHMIC_PORT: "bad", LOG_ARITHMIC_ADMIN_TOKEN: admin })).toThrow("LOG_ARITHMIC_PORT");
    expect(() => loadConfig({ LOG_ARITHMIC_PORT: "70000", LOG_ARITHMIC_ADMIN_TOKEN: admin })).toThrow("65535");
    expect(() => loadConfig({ LOG_ARITHMIC_ADMIN_TOKEN: "short" })).toThrow("32 characters");
    expect(loadConfig({}).adminToken).toBe("");
  });

  test("normalizes timestamps and fills project/environment scope", () => {
    const normalized = normalizeLog({ level: "error", message: "failed", timestamp: 1_700_000_000_000 }, { project: "checkout", environment: "test" });
    expect(normalized.timestamp).toBe("2023-11-14T22:13:20.000Z");
    expect(normalized.project).toBe("checkout");
    expect(normalized.environment).toBe("test");
    expect(normalized.id.startsWith(normalized.timestamp.slice(0, 10))).toBeFalse();
  });

  test("rejects invalid levels and oversized metadata", () => {
    expect(() => normalizeLog({ level: "notice", message: "bad" })).toThrow(ValidationError);
    expect(() => normalizeLog({ level: "info", message: "bad", metadata: { value: "x".repeat(66_000) } })).toThrow("metadata");
  });

  test("API keys are scoped, revocable, and never returned when listed", () => {
    const store = new SQLiteLogStore(":memory:");
    const keys = new KeyManager(store.database);
    const created = keys.create("payments", "production");
    expect(created.secret.startsWith("lf_")).toBeTrue();
    expect(keys.authenticate(created.secret)).toEqual({ id: created.id, project: "payments", environment: "production" });
    expect(keys.list()[0]).not.toHaveProperty("secret");
    expect(keys.revoke(created.id)).toBeTrue();
    expect(keys.authenticate(created.secret)).toBeNull();
    expect(constantTimeEqual("same", "same")).toBeTrue();
    expect(constantTimeEqual("same", "other")).toBeFalse();
    store.close();
  });
});

describe("SQLite log store", () => {
  test("inserts atomically, filters, pages with a cursor, finds traces, and expires rows", () => {
    const store = new SQLiteLogStore(":memory:");
    const logs = [1, 2, 3].map((n) => normalizeLog({
      timestamp: `2025-01-01T00:00:0${n}.000Z`,
      level: n === 3 ? "error" : "info",
      message: `event ${n}`,
      service: "payments",
      traceId: n < 3 ? "trace-1" : "trace-2",
    }, { project: "demo", environment: "test" }));
    store.insert(logs);
    const first = store.query({ project: "demo", environment: "test", limit: 2 });
    expect(first.logs.map((item) => item.message)).toEqual(["event 3", "event 2"]);
    expect(first.nextCursor).not.toBeNull();
    const second = store.query({ project: "demo", environment: "test", limit: 2, cursor: first.nextCursor! });
    expect(second.logs.map((item) => item.message)).toEqual(["event 1"]);
    expect(second.nextCursor).toBeNull();
    expect(store.query({ project: "demo", environment: "test", search: "EVENT 1", limit: 5 }).logs).toHaveLength(1);
    expect(store.trace("trace-1").map((item) => item.message)).toEqual(["event 1", "event 2"]);
    expect(store.removeBefore("2025-01-01T00:00:03.000Z")).toBe(2);
    expect(store.count()).toBe(1);
    store.close();
  });

  test("subscribers receive only matching project and level events", () => {
    const bus = new InMemoryEventBus();
    let received = 0;
    const unsubscribe = bus.subscribe({ project: "a", level: "error" }, () => { received += 1; });
    const base = normalizeLog({ level: "error", message: "x" }, { project: "a" });
    bus.publish([base, { ...base, id: "other", project: "b" }, { ...base, id: "info", level: "info" }]);
    expect(received).toBe(1);
    expect(bus.subscriberCount).toBe(1);
    unsubscribe();
    expect(bus.subscriberCount).toBe(0);
  });
});

describe("HTTP API integration", () => {
  test("authenticates scoped batch ingestion and supports query and export", async () => {
    const store = new SQLiteLogStore(":memory:");
    const keys = new KeyManager(store.database);
    const apiKey = keys.create("project-a", "staging");
    const handler = createHandler({
      config: {
        host: "127.0.0.1", port: 8787, database: ":memory:", adminToken: "admin-secret",
        retentionDays: 30, corsOrigin: "*", rateLimit: 100, maxBatchSize: 10, maxRequestBytes: 50_000,
      },
      store, keys, bus: new InMemoryEventBus(), startedAt: Date.now(), counts: { ingested: 0 },
    });
    const headers = { Authorization: `Bearer ${apiKey.secret}`, "Content-Type": "application/json" };
    const unauthorized = await handler(new Request("http://localhost/api/v1/logs", { method: "POST", body: JSON.stringify({ level: "info", message: "no" }) }));
    expect(unauthorized.status).toBe(401);
    const accepted = await handler(new Request("http://localhost/api/v1/logs/batch", {
      method: "POST", headers, body: JSON.stringify({ logs: [{ level: "error", message: "payment failed", service: "payments", traceId: "trace" }] }),
    }));
    expect(accepted.status).toBe(202);
    const query = await handler(new Request("http://localhost/api/v1/logs?level=error", { headers }));
    expect((await query.json() as { logs: unknown[] }).logs).toHaveLength(1);
    const trace = await handler(new Request("http://localhost/api/v1/traces/trace", { headers }));
    expect((await trace.json() as { logs: unknown[] }).logs).toHaveLength(1);
    const exported = await handler(new Request("http://localhost/api/v1/logs/export?format=ndjson", { headers }));
    expect(await exported.text()).toContain("payment failed");
    store.close();
  });

  test("streams persisted events after subscription and cancels cleanly", async () => {
    const store = new SQLiteLogStore(":memory:");
    const keys = new KeyManager(store.database);
    const apiKey = keys.create("demo", "test");
    const bus = new InMemoryEventBus();
    const handler = createHandler({
      config: {
        host: "127.0.0.1", port: 8787, database: ":memory:", adminToken: "admin",
        retentionDays: 30, corsOrigin: "*", rateLimit: 100, maxBatchSize: 10, maxRequestBytes: 50_000,
      }, store, keys, bus, startedAt: Date.now(), counts: { ingested: 0 },
    });
    const response = await handler(new Request("http://localhost/api/v1/stream", { headers: { Authorization: `Bearer ${apiKey.secret}` } }));
    expect(bus.subscriberCount).toBe(1);
    const reader = response.body!.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("event: ready");
    bus.publish([normalizeLog({ level: "info", message: "streamed" }, { project: "demo", environment: "test" })]);
    const incoming = await reader.read();
    expect(new TextDecoder().decode(incoming.value)).toContain("streamed");
    await reader.cancel();
    expect(bus.subscriberCount).toBe(0);
    store.close();
  });
});

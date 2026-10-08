import { describe, expect, test } from "bun:test";
import { LogForge } from "./index";

describe("Log Arithmic SDK", () => {
  test("batches structured events and flushes on shutdown", async () => {
    const requests: Array<{ url: string; body: { logs: Array<Record<string, unknown>> }; headers: Headers }> = [];
    const logger = new LogForge({
      endpoint: "http://localhost:8787/",
      apiKey: "lf_test",
      service: "checkout",
      batchSize: 2,
      flushIntervalMs: 60_000,
      fetch: async (input, init) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as { logs: Array<Record<string, unknown>> }, headers: new Headers(init?.headers) });
        return new Response(null, { status: 202 });
      },
    });
    logger.info("started");
    logger.error("failed", { traceId: "tr_1", metadata: { orderId: 42 } });
    await logger.flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://localhost:8787/api/v1/logs/batch");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer lf_test");
    expect(requests[0]?.body.logs[1]).toMatchObject({ level: "error", traceId: "tr_1", metadata: { orderId: 42 }, service: "checkout" });
    await logger.shutdown();
  });

  test("retains failed batches so callers can retry flush", async () => {
    let attempts = 0;
    const logger = new LogForge({
      endpoint: "http://localhost:8787",
      apiKey: "lf_test",
      batchSize: 20,
      flushIntervalMs: 60_000,
      fetch: async () => {
        attempts += 1;
        return new Response(null, { status: attempts === 1 ? 503 : 202 });
      },
      onError: () => {},
    });
    logger.warn("retry me");
    await expect(logger.flush()).rejects.toThrow("HTTP 503");
    await logger.flush();
    expect(attempts).toBe(2);
    await logger.shutdown();
  });

  test("validates batch and queue settings", () => {
    expect(() => new LogForge({ endpoint: "http://localhost", apiKey: "key", batchSize: 0 })).toThrow("batchSize");
  });
});

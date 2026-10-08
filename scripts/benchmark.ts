const endpoint = (process.env.LOG_ARITHMIC_URL || process.env.LOGFORGE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const apiKey = process.env.LOG_ARITHMIC_API_KEY || process.env.LOGFORGE_API_KEY;
const total = Number(process.env.BENCHMARK_EVENTS || 10_000);
const batchSize = Number(process.env.BENCHMARK_BATCH_SIZE || 250);

if (!apiKey) throw new Error("Set LOG_ARITHMIC_API_KEY to a project API key before running the benchmark");
if (!Number.isInteger(total) || total < 1 || !Number.isInteger(batchSize) || batchSize < 1) {
  throw new Error("BENCHMARK_EVENTS and BENCHMARK_BATCH_SIZE must be positive integers");
}

const latencies: number[] = [];
const started = performance.now();
let sent = 0;
while (sent < total) {
  const count = Math.min(batchSize, total - sent);
  const logs = Array.from({ length: count }, (_, index) => ({
    level: index % 20 === 0 ? "error" : "info",
    message: `benchmark event ${sent + index}`,
    service: "logforge-benchmark",
    metadata: { sequence: sent + index, group: "ingestion-benchmark" },
  }));
  const requestStart = performance.now();
  const response = await fetch(`${endpoint}/api/v1/logs/batch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ logs }),
  });
  latencies.push(performance.now() - requestStart);
  if (!response.ok) throw new Error(`Batch ${sent} failed with HTTP ${response.status}: ${await response.text()}`);
  sent += count;
}

latencies.sort((left, right) => left - right);
const elapsedSeconds = (performance.now() - started) / 1000;
const meanBatchLatency = latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length;
console.log(JSON.stringify({
  events: sent,
  batchSize,
  batches: latencies.length,
  elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
  eventsPerSecond: Number((sent / elapsedSeconds).toFixed(1)),
  meanBatchLatencyMs: Number(meanBatchLatency.toFixed(2)),
  p95BatchLatencyMs: Number((latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] || 0).toFixed(2)),
}, null, 2));

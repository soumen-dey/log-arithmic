#!/usr/bin/env bun

const args = process.argv.slice(2);
const command = args[0] || "help";
const api = (process.env.LOG_ARITHMIC_URL || process.env.LOGFORGE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const key = process.env.LOG_ARITHMIC_API_KEY || process.env.LOGFORGE_API_KEY || "";

function value(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function request(path: string, authenticated = true): Promise<Response> {
  if (authenticated && !key) throw new Error("Set LOG_ARITHMIC_API_KEY to a project API key");
  return fetch(`${api}${path}`, { headers: authenticated ? { Authorization: `Bearer ${key}` } : {} });
}

async function main() {
  if (command === "health") {
    const response = await request("/health", false);
    console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }
  if (command === "projects") {
    const response = await request("/api/v1/projects");
    if (!response.ok) throw new Error(`API request failed (${response.status})`);
    console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }
  if (command === "logs" || command === "tail") {
    const params = new URLSearchParams();
    for (const [flag, parameter] of [["--service", "service"], ["--level", "level"], ["--trace", "traceId"], ["--search", "search"]] as const) {
      const selected = value(flag);
      if (selected) params.set(parameter, selected);
    }
    if (command === "tail" || args.includes("--follow")) {
      if (!key) throw new Error("Set LOG_ARITHMIC_API_KEY to a project API key");
      const controller = new AbortController();
      process.on("SIGINT", () => controller.abort());
      const response = await fetch(`${api}/api/v1/stream?${params}`, {
        headers: { Authorization: `Bearer ${key}`, Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`Live stream failed (${response.status})`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        buffered += decoder.decode(chunk, { stream: true });
        const frames = buffered.split("\n\n");
        buffered = frames.pop() || "";
        for (const frame of frames) {
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data) console.log(data.slice(6));
        }
      }
      return;
    }
    const format = value("--format") || "json";
    params.set("format", format);
    const response = await request(`/api/v1/logs/export?${params}`);
    if (!response.ok) throw new Error(`Log query failed (${response.status}): ${await response.text()}`);
    console.log(await response.text());
    return;
  }
  console.log(`Log Arithmic CLI

Usage:
  bun apps/cli/src/index.ts health
  bun apps/cli/src/index.ts projects
  bun apps/cli/src/index.ts logs [--service NAME] [--level LEVEL] [--trace ID] [--search TEXT] [--format json|ndjson|csv]
  bun apps/cli/src/index.ts logs --follow
  bun apps/cli/src/index.ts tail [filters...]

Set LOG_ARITHMIC_URL (default http://127.0.0.1:8787) and LOG_ARITHMIC_API_KEY.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

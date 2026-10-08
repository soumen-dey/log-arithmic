export interface Config {
  host: string;
  port: number;
  database: string;
  adminToken: string;
  retentionDays: number;
  corsOrigin: string;
  rateLimit: number;
  maxBatchSize: number;
  maxRequestBytes: number;
}

function integer(name: string, value: string | undefined, fallback: number, minimum: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return parsed;
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
  const setting = (name: string) => env[`LOG_ARITHMIC_${name}`] ?? env[`LOGFORGE_${name}`];
  const config = {
    host: setting("HOST") || "127.0.0.1",
    port: integer("LOG_ARITHMIC_PORT", setting("PORT"), 8787, 1),
    database: setting("DATABASE") || "./data/log-arithmic.sqlite",
    adminToken: setting("ADMIN_TOKEN") || "",
    retentionDays: integer("LOG_ARITHMIC_RETENTION_DAYS", setting("RETENTION_DAYS"), 30, 0),
    corsOrigin: setting("CORS_ORIGIN") || "http://localhost:5173",
    rateLimit: integer("LOG_ARITHMIC_RATE_LIMIT", setting("RATE_LIMIT"), 120, 1),
    maxBatchSize: integer("LOG_ARITHMIC_MAX_BATCH_SIZE", setting("MAX_BATCH_SIZE"), 500, 1),
    maxRequestBytes: integer("LOG_ARITHMIC_MAX_REQUEST_BYTES", setting("MAX_REQUEST_BYTES"), 1_048_576, 1),
  };
  if (config.port > 65_535) throw new Error("LOG_ARITHMIC_PORT must not exceed 65535");
  if (config.adminToken && config.adminToken.length < 32) {
    throw new Error("LOG_ARITHMIC_ADMIN_TOKEN must contain at least 32 characters");
  }
  return config;
}

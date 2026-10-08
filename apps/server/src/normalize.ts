import { randomUUID } from "node:crypto";
import { LOG_LEVELS, type LogInput, type LogEvent } from "./model";

export class ValidationError extends Error {}

export function normalizeLog(value: unknown, defaults: { project?: string; service?: string; environment?: string } = {}): LogEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Each log must be an object");
  const input = value as Record<string, unknown>;
  if (typeof input.level !== "string" || !LOG_LEVELS.includes(input.level as LogInput["level"])) {
    throw new ValidationError("level must be one of: debug, info, warn, error, fatal");
  }
  if (typeof input.message !== "string" || input.message.length === 0 || input.message.length > 16_384) {
    throw new ValidationError("message must be a non-empty string of at most 16384 characters");
  }
  for (const key of ["project", "service", "environment", "traceId", "requestId", "host", "source"] as const) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || input[key].length > 256)) {
      throw new ValidationError(`${key} must be a string of at most 256 characters`);
    }
  }
  const metadata = input.metadata === undefined ? {} : input.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new ValidationError("metadata must be a JSON object");
  }
  let metadataJson: string;
  try {
    metadataJson = JSON.stringify(metadata);
  } catch {
    throw new ValidationError("metadata must contain JSON-serializable values");
  }
  if (Buffer.byteLength(metadataJson, "utf8") > 65_536) throw new ValidationError("metadata must not exceed 65536 bytes");

  let date = new Date();
  if (input.timestamp !== undefined) {
    date = typeof input.timestamp === "number" ? new Date(input.timestamp) : new Date(String(input.timestamp));
    if (!Number.isFinite(date.getTime())) throw new ValidationError("timestamp must be a valid date or epoch milliseconds");
  }
  const now = Date.now();
  const sortableTime = date.getTime().toString(36).padStart(10, "0");
  return {
    id: `${sortableTime}_${randomUUID()}`,
    project: (input.project as string | undefined) || defaults.project || "default",
    timestamp: date.toISOString(),
    level: input.level as LogInput["level"],
    message: input.message,
    service: (input.service as string | undefined) || defaults.service || "default",
    environment: (input.environment as string | undefined) || defaults.environment || "production",
    traceId: (input.traceId as string | undefined) || null,
    requestId: (input.requestId as string | undefined) || null,
    host: (input.host as string | undefined) || null,
    source: (input.source as string | undefined) || null,
    metadata: JSON.parse(metadataJson) as Record<string, unknown>,
  };
}

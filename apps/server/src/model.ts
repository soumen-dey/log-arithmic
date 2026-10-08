export const LOG_LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogInput {
  timestamp?: string | number;
  project?: string;
  level: LogLevel;
  message: string;
  service?: string;
  environment?: string;
  traceId?: string;
  requestId?: string;
  host?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface LogEvent {
  id: string;
  project: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  service: string;
  environment: string;
  traceId: string | null;
  requestId: string | null;
  host: string | null;
  source: string | null;
  metadata: Record<string, unknown>;
}

export interface LogFilters {
  project?: string;
  from?: string;
  to?: string;
  level?: LogLevel;
  service?: string;
  environment?: string;
  traceId?: string;
  requestId?: string;
  search?: string;
  cursor?: string;
  limit: number;
}

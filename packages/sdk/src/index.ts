export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogOptions {
  service?: string;
  environment?: string;
  traceId?: string;
  requestId?: string;
  host?: string;
  source?: string;
  timestamp?: string | number;
  metadata?: Record<string, unknown>;
}

export interface LogForgeOptions {
  endpoint: string;
  apiKey: string;
  service?: string;
  environment?: string;
  batchSize?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  fetch?: typeof fetch;
  onError?: (error: Error) => void;
}

export class LogForge {
  private readonly queue: Array<Record<string, unknown>> = [];
  private readonly endpoint: string;
  private readonly send: typeof fetch;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly batchSize: number;
  private readonly maxQueueSize: number;
  private activeFlush?: Promise<void>;

  constructor(private readonly options: LogForgeOptions) {
    if (!options.endpoint || !options.apiKey) throw new Error("Log Arithmic endpoint and apiKey are required");
    this.endpoint = `${options.endpoint.replace(/\/+$/, "")}/api/v1/logs/batch`;
    this.send = options.fetch || fetch;
    this.batchSize = options.batchSize ?? 50;
    this.maxQueueSize = options.maxQueueSize ?? 10_000;
    const flushIntervalMs = options.flushIntervalMs ?? 1_000;
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) throw new Error("batchSize must be a positive integer");
    if (!Number.isInteger(this.maxQueueSize) || this.maxQueueSize < this.batchSize) {
      throw new Error("maxQueueSize must be an integer greater than or equal to batchSize");
    }
    if (!Number.isInteger(flushIntervalMs) || flushIntervalMs < 1) throw new Error("flushIntervalMs must be a positive integer");
    this.timer = setInterval(() => {
      void this.flush().catch((error: unknown) => this.report(error));
    }, flushIntervalMs);
  }

  debug(message: string, options: LogOptions = {}): void { this.log("debug", message, options); }
  info(message: string, options: LogOptions = {}): void { this.log("info", message, options); }
  warn(message: string, options: LogOptions = {}): void { this.log("warn", message, options); }
  error(message: string, options: LogOptions = {}): void { this.log("error", message, options); }
  fatal(message: string, options: LogOptions = {}): void { this.log("fatal", message, options); }

  log(level: LogLevel, message: string, options: LogOptions = {}): void {
    const { metadata, ...fields } = options;
    if (this.queue.length >= this.maxQueueSize) {
      this.report(new Error(`Log Arithmic queue is full (${this.maxQueueSize}); event dropped`));
      return;
    }
    this.queue.push({
      timestamp: fields.timestamp ?? new Date().toISOString(),
      level,
      message,
      service: fields.service ?? this.options.service,
      environment: fields.environment ?? this.options.environment,
      traceId: fields.traceId,
      requestId: fields.requestId,
      host: fields.host,
      source: fields.source,
      metadata: metadata ?? {},
    });
    if (this.queue.length >= this.batchSize) {
      void this.flush().catch((error: unknown) => this.report(error));
    }
  }

  flush(): Promise<void> {
    if (this.activeFlush) return this.activeFlush;
    this.activeFlush = this.drain().finally(() => { this.activeFlush = undefined; });
    return this.activeFlush;
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.batchSize);
      try {
        const response = await this.send(this.endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ logs: batch }),
        });
        if (!response.ok) throw new Error(`Log Arithmic ingestion returned HTTP ${response.status}`);
      } catch (error) {
        const available = Math.max(0, this.maxQueueSize - batch.length);
        if (this.queue.length > available) {
          const dropped = this.queue.length - available;
          this.queue.splice(available);
          this.report(new Error(`Log Arithmic queue dropped ${dropped} newer event(s) while restoring a failed batch`));
        }
        this.queue.unshift(...batch);
        throw error;
      }
    }
  }

  private report(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (this.options.onError) this.options.onError(normalized);
    else console.error("Log Arithmic SDK:", normalized.message);
  }
}

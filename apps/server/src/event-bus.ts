import type { LogEvent, LogFilters } from "./model";

export interface EventBus {
  publish(events: LogEvent[]): void;
  subscribe(filters: Partial<LogFilters>, listener: (event: LogEvent) => void): () => void;
  readonly subscriberCount: number;
}

function matches(event: LogEvent, filters: Partial<LogFilters>): boolean {
  return (!filters.project || event.project === filters.project)
    && (!filters.level || event.level === filters.level)
    && (!filters.service || event.service === filters.service)
    && (!filters.environment || event.environment === filters.environment)
    && (!filters.traceId || event.traceId === filters.traceId)
    && (!filters.search || event.message.toLowerCase().includes(filters.search.toLowerCase()));
}

export class InMemoryEventBus implements EventBus {
  private readonly listeners = new Set<{ filters: Partial<LogFilters>; listener: (event: LogEvent) => void }>();

  get subscriberCount(): number {
    return this.listeners.size;
  }

  publish(events: LogEvent[]): void {
    for (const event of events) {
      for (const subscription of this.listeners) {
        if (matches(event, subscription.filters)) {
          try {
            subscription.listener(event);
          } catch (error) {
            console.error("Realtime subscriber failed:", error);
          }
        }
      }
    }
  }

  subscribe(filters: Partial<LogFilters>, listener: (event: LogEvent) => void): () => void {
    const subscription = { filters, listener };
    this.listeners.add(subscription);
    return () => this.listeners.delete(subscription);
  }
}

import { Injectable } from '@nestjs/common';

export type CounterName =
  | 'sqs_messages_processed'
  | 'sqs_messages_duplicate'
  | 'sqs_messages_failed'
  | 'sqs_polling_failed'
  | 'outbox_events_published'
  | 'outbox_events_failed'
  | 'pending_reference_retries_failed';

export type TimingName =
  'sqs_processing_ms' | 'outbox_publication_ms' | 'outbox_delay_ms';

export interface TimingStats {
  count: number;
  totalMs: number;
  averageMs: number;
  maxMs: number;
}

@Injectable()
export class MetricsService {
  private readonly startedAt = new Date();

  private readonly counters: Record<CounterName, number> = {
    sqs_messages_processed: 0,
    sqs_messages_duplicate: 0,
    sqs_messages_failed: 0,
    sqs_polling_failed: 0,
    outbox_events_published: 0,
    outbox_events_failed: 0,
    pending_reference_retries_failed: 0,
  };

  private readonly timings: Record<
    TimingName,
    { count: number; totalMs: number; maxMs: number }
  > = {
    sqs_processing_ms: { count: 0, totalMs: 0, maxMs: 0 },
    outbox_publication_ms: { count: 0, totalMs: 0, maxMs: 0 },
    outbox_delay_ms: { count: 0, totalMs: 0, maxMs: 0 },
  };

  // Incrementa um contador sem armazenar dados pessoais.
  increment(name: CounterName): void {
    this.counters[name]++;
  }

  // Registra a duração de uma operação em milissegundos.
  observe(name: TimingName, milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      return;
    }

    const timing = this.timings[name];

    timing.count++;
    timing.totalMs += milliseconds;
    timing.maxMs = Math.max(timing.maxMs, milliseconds);
  }

  snapshot() {
    const timings = {} as Record<TimingName, TimingStats>;

    for (const name of Object.keys(this.timings) as TimingName[]) {
      const timing = this.timings[name];

      timings[name] = {
        count: timing.count,
        totalMs: timing.totalMs,
        averageMs: timing.count > 0 ? timing.totalMs / timing.count : 0,
        maxMs: timing.maxMs,
      };
    }

    return {
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
      counters: { ...this.counters },
      timings,
    };
  }
}

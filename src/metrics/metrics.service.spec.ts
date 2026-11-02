import { describe, expect, it } from 'vitest';
import { MetricsService } from './metrics.service.js';

describe('MetricsService', () => {
  it('should initialize counters with zero', () => {
    const metrics = new MetricsService();

    const result = metrics.snapshot();

    expect(result.counters.sqs_messages_processed).toBe(0);
    expect(result.counters.outbox_events_published).toBe(0);
    expect(result.timings.sqs_processing_ms.count).toBe(0);
  });

  it('should increment counters', () => {
    const metrics = new MetricsService();

    metrics.increment('sqs_messages_processed');
    metrics.increment('sqs_messages_processed');
    metrics.increment('sqs_messages_duplicate');

    const result = metrics.snapshot();

    expect(result.counters.sqs_messages_processed).toBe(2);
    expect(result.counters.sqs_messages_duplicate).toBe(1);
  });

  it('should calculate processing time statistics', () => {
    const metrics = new MetricsService();

    metrics.observe('sqs_processing_ms', 100);
    metrics.observe('sqs_processing_ms', 300);

    const result = metrics.snapshot();
    const timing = result.timings.sqs_processing_ms;

    expect(timing.count).toBe(2);
    expect(timing.totalMs).toBe(400);
    expect(timing.averageMs).toBe(200);
    expect(timing.maxMs).toBe(300);
  });

  it('should ignore invalid durations', () => {
    const metrics = new MetricsService();

    metrics.observe('outbox_delay_ms', -10);
    metrics.observe('outbox_delay_ms', Number.NaN);
    metrics.observe('outbox_delay_ms', Number.POSITIVE_INFINITY);

    expect(metrics.snapshot().timings.outbox_delay_ms.count).toBe(0);
  });

  it('should return an independent snapshot', () => {
    const metrics = new MetricsService();

    const first = metrics.snapshot();
    metrics.increment('sqs_messages_failed');
    const second = metrics.snapshot();

    expect(first.counters.sqs_messages_failed).toBe(0);
    expect(second.counters.sqs_messages_failed).toBe(1);
  });
});

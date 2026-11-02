import { describe, expect, it, vi } from 'vitest';
import { EntityManager } from '@mikro-orm/postgresql';

import { MetricsService } from '../../metrics/metrics.service.js';
import { OutboxPublisherService } from './outbox-publisher.service.js';

interface TestPublisherInternals {
  runCycle(): Promise<void>;
  claimNext(): Promise<unknown>;
  publish(): Promise<void>;
  markPublished(): Promise<void>;
  client: {
    destroy(): void;
  };
}

describe('OutboxPublisherService shutdown', () => {
  it('should finish the publication before destroying the SQS client', async () => {
    const metrics = new MetricsService();

    // O banco não será acessado: os métodos externos serão simulados.
    const em = {} as EntityManager;
    const publisher = new OutboxPublisherService(em, metrics);

    const internals = publisher as unknown as TestPublisherInternals;

    const claimNext = vi
      .spyOn(internals, 'claimNext')
      .mockResolvedValueOnce({
        id: 'event-123',
        aggregate_id: 'wallet-123',
        event_type: 'WalletBalanceChanged',
        payload: { eventId: 'event-123' },
        attempts: 1,
        occurred_at: new Date(),
      })
      .mockResolvedValue(null);

    let finishPublication!: () => void;

    const publication = new Promise<void>((resolve) => {
      finishPublication = resolve;
    });

    const publish = vi.spyOn(internals, 'publish').mockReturnValue(publication);

    const markPublished = vi
      .spyOn(internals, 'markPublished')
      .mockResolvedValue(undefined);

    const destroy = vi
      .spyOn(internals.client, 'destroy')
      .mockImplementation(() => undefined);

    // Inicia um ciclo e mantém a publicação pendente.
    const runningCycle = internals.runCycle();

    // Aguarda o ciclo alcançar o método publish().
    await vi.waitFor(() => {
      expect(publish).toHaveBeenCalledOnce();
    });

    let shutdownFinished = false;

    const shutdown = publisher.onModuleDestroy().then(() => {
      shutdownFinished = true;
    });

    expect(shutdownFinished).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
    expect(markPublished).not.toHaveBeenCalled();

    // Permite a conclusão da publicação SQS.
    finishPublication();

    await runningCycle;
    await shutdown;

    expect(markPublished).toHaveBeenCalledWith('event-123');
    expect(destroy).toHaveBeenCalledOnce();
    expect(shutdownFinished).toBe(true);

    // Não deve reservar novos eventos após o desligamento.
    await internals.runCycle();

    expect(claimNext).toHaveBeenCalledTimes(1);

    const snapshot = metrics.snapshot();

    expect(snapshot.counters.outbox_events_published).toBe(1);
    expect(snapshot.timings.outbox_publication_ms.count).toBe(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { EntityManager } from '@mikro-orm/postgresql';

import { MetricsService } from '../metrics/metrics.service.js';
import { WageringService } from './wagering.service.js';
import { PendingReferenceWorker } from './pending-reference.worker.js';

interface WorkerInternals {
  runCycle(): Promise<void>;
}

describe('PendingReferenceWorker shutdown', () => {
  it('should finish the current retry and stop before the next one', async () => {
    const find = vi
      .fn()
      .mockResolvedValue([{ id: 'transaction-1' }, { id: 'transaction-2' }]);

    const fork = vi.fn().mockReturnValue({ find });

    const em = {
      fork,
    } as unknown as EntityManager;

    let finishRetry!: () => void;

    const pendingRetry = new Promise<void>((resolve) => {
      finishRetry = resolve;
    });

    const retryPendingTransaction = vi
      .fn()
      .mockReturnValueOnce(pendingRetry)
      .mockResolvedValue(undefined);

    const wageringService = {
      retryPendingTransaction,
    } as unknown as WageringService;

    const metrics = new MetricsService();

    const worker = new PendingReferenceWorker(em, wageringService, metrics);

    const internals = worker as unknown as WorkerInternals;

    // Inicia um ciclo e mantém o primeiro retry em andamento.
    const runningCycle = internals.runCycle();

    await vi.waitFor(() => {
      expect(retryPendingTransaction).toHaveBeenCalledWith('transaction-1');
    });

    let shutdownFinished = false;

    // Solicita desligamento antes de terminar o primeiro retry.
    const shutdown = worker.onModuleDestroy().then(() => {
      shutdownFinished = true;
    });

    expect(shutdownFinished).toBe(false);

    // Libera a operação financeira que estava em andamento.
    finishRetry();

    await runningCycle;
    await shutdown;

    // A primeira operação terminou, mas a segunda não começou.
    expect(retryPendingTransaction).toHaveBeenCalledTimes(1);
    expect(retryPendingTransaction).not.toHaveBeenCalledWith('transaction-2');

    expect(shutdownFinished).toBe(true);

    // Nenhuma nova consulta deve começar após o encerramento.
    await internals.runCycle();

    expect(fork).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('should count a failed retry attempt', async () => {
    const find = vi.fn().mockResolvedValue([{ id: 'transaction-failed' }]);

    const em = {
      fork: vi.fn().mockReturnValue({ find }),
    } as unknown as EntityManager;

    const retryPendingTransaction = vi
      .fn()
      .mockRejectedValue(new Error('Temporary database error'));

    const wageringService = {
      retryPendingTransaction,
    } as unknown as WageringService;

    const metrics = new MetricsService();

    const worker = new PendingReferenceWorker(em, wageringService, metrics);

    await (worker as unknown as WorkerInternals).runCycle();

    expect(retryPendingTransaction).toHaveBeenCalledWith('transaction-failed');

    expect(metrics.snapshot().counters.pending_reference_retries_failed).toBe(
      1,
    );

    await worker.onModuleDestroy();
  });
});

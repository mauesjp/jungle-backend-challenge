import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Logger } from '@nestjs/common';

import {
  parseWagerMessage,
  SqsConsumerService,
} from './sqs-consumer.service.js';

import { MetricsService } from '../../metrics/metrics.service.js';

import type { SqsService } from './sqs.service.js';
import type { WageringService } from '../../wagering/wagering.service.js';

const validMessage = {
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-11-02T20:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'bet-123',
    idempotencyKey: 'provider-a:bet-123',
    playerId: 'player-123',
    walletId: 'wallet-123',
    roundId: 'round-123',
    gameId: 'game-123',
    kind: 'BET',
    money: {
      amount: '30.00',
      currency: 'BRL',
    },
  },
};

function createTestConsumer(body: string) {
  const receive = vi.fn().mockResolvedValue([
    {
      MessageId: 'aws-msg-123',
      ReceiptHandle: 'receipt-123',
      Body: body,
    },
  ]);

  const acknowledge = vi.fn().mockResolvedValue(undefined);

  const processFromQueue = vi.fn().mockResolvedValue({
    alreadyProcessed: false,
    result: { status: 'PROCESSED' },
  });

  const sqs = {
    receive,
    acknowledge,
  } as unknown as SqsService;

  const wageringService = {
    processFromQueue,
  } as unknown as WageringService;

  const metrics = new MetricsService();

  const consumer = new SqsConsumerService(sqs, wageringService, metrics);

  // Executa um ciclo manualmente, sem criar intervalos.
  const poll = () =>
    (
      consumer as unknown as {
        poll(): Promise<void>;
      }
    ).poll();

  return {
    poll,
    receive,
    acknowledge,
    processFromQueue,
    metrics,
    consumer,
  };
}

describe('SQS message contract', () => {
  it('should accept the official wagering envelope', () => {
    const result = parseWagerMessage(JSON.stringify(validMessage));

    expect(result.messageId).toBe('msg-123');
    expect(result.type).toBe('WagerTransactionRequested');
    expect(result.data.idempotencyKey).toBe('provider-a:bet-123');
    expect(result.data.money.amount).toBe('30.00');
  });

  it('should reject an unknown message type', () => {
    const message = { ...validMessage, type: 'UnknownEvent' };

    expect(() => parseWagerMessage(JSON.stringify(message))).toThrow(
      'Invalid SQS message envelope',
    );
  });

  it('should reject a missing business message ID', () => {
    const message = { ...validMessage, messageId: '' };

    expect(() => parseWagerMessage(JSON.stringify(message))).toThrow(
      'Invalid SQS message envelope',
    );
  });

  it('should reject a missing idempotency key', () => {
    const message = {
      ...validMessage,
      data: { ...validMessage.data, idempotencyKey: '' },
    };

    expect(() => parseWagerMessage(JSON.stringify(message))).toThrow(
      'Invalid SQS idempotency key',
    );
  });

  it('should reject malformed JSON', () => {
    expect(() => parseWagerMessage('{invalid-json')).toThrow();
  });
});

describe('SQS consumer failure handling and metrics', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should acknowledge a successfully processed transaction', async () => {
    const test = createTestConsumer(JSON.stringify(validMessage));

    await test.poll();

    expect(test.processFromQueue).toHaveBeenCalledOnce();

    expect(test.processFromQueue).toHaveBeenCalledWith(
      'msg-123',
      expect.objectContaining({
        providerId: 'provider-a',
        externalTransactionId: 'bet-123',
      }),
      'provider-a:bet-123',
    );

    expect(test.acknowledge).toHaveBeenCalledWith('receipt-123');

    const snapshot = test.metrics.snapshot();

    expect(snapshot.counters.sqs_messages_processed).toBe(1);
    expect(snapshot.counters.sqs_messages_failed).toBe(0);
    expect(snapshot.timings.sqs_processing_ms.count).toBe(1);
  });

  it('should acknowledge a financially rejected transaction', async () => {
    const test = createTestConsumer(JSON.stringify(validMessage));

    test.processFromQueue.mockResolvedValue({
      alreadyProcessed: false,
      result: { status: 'REJECTED' },
    });

    await test.poll();

    expect(test.processFromQueue).toHaveBeenCalledOnce();
    expect(test.acknowledge).toHaveBeenCalledWith('receipt-123');
    expect(test.metrics.snapshot().counters.sqs_messages_processed).toBe(1);
  });

  it('should acknowledge and count a previously processed message', async () => {
    const test = createTestConsumer(JSON.stringify(validMessage));

    test.processFromQueue.mockResolvedValue({
      alreadyProcessed: true,
    });

    await test.poll();

    expect(test.acknowledge).toHaveBeenCalledWith('receipt-123');

    const snapshot = test.metrics.snapshot();

    expect(snapshot.counters.sqs_messages_processed).toBe(1);
    expect(snapshot.counters.sqs_messages_duplicate).toBe(1);
  });

  it('should not acknowledge an invalid message', async () => {
    const test = createTestConsumer('{invalid-json');

    await test.poll();

    expect(test.processFromQueue).not.toHaveBeenCalled();
    expect(test.acknowledge).not.toHaveBeenCalled();
    expect(test.metrics.snapshot().counters.sqs_messages_failed).toBe(1);
  });

  it('should not acknowledge when financial processing fails', async () => {
    const test = createTestConsumer(JSON.stringify(validMessage));

    test.processFromQueue.mockRejectedValue(
      new Error('Database connection unavailable'),
    );

    await test.poll();

    expect(test.processFromQueue).toHaveBeenCalledOnce();
    expect(test.acknowledge).not.toHaveBeenCalled();

    const snapshot = test.metrics.snapshot();

    expect(snapshot.counters.sqs_messages_failed).toBe(1);
    expect(snapshot.timings.sqs_processing_ms.count).toBe(1);
  });

  it('should not process a message when receiving from SQS fails', async () => {
    const test = createTestConsumer(JSON.stringify(validMessage));

    test.receive.mockRejectedValue(new Error('SQS connection unavailable'));

    await test.poll();

    expect(test.processFromQueue).not.toHaveBeenCalled();
    expect(test.acknowledge).not.toHaveBeenCalled();
    expect(test.metrics.snapshot().counters.sqs_polling_failed).toBe(1);
  });

  it('should wait for in-flight processing before shutdown', async () => {
    const test = createTestConsumer(JSON.stringify(validMessage));

    let finishProcessing!: (value: { alreadyProcessed: boolean }) => void;

    const processing = new Promise<{ alreadyProcessed: boolean }>((resolve) => {
      finishProcessing = resolve;
    });

    test.processFromQueue.mockReturnValue(processing);

    // Inicia o processamento sem aguardar sua conclusão.
    const runningCycle = test.poll();

    // Permite que a leitura simulada do SQS seja concluída.
    await Promise.resolve();
    await Promise.resolve();

    expect(test.processFromQueue).toHaveBeenCalledOnce();

    let shutdownFinished = false;

    // Inicia o encerramento enquanto a operação está pendente.
    const shutdown = test.consumer.onModuleDestroy().then(() => {
      shutdownFinished = true;
    });

    await Promise.resolve();

    // O encerramento não pode terminar antes da operação.
    expect(shutdownFinished).toBe(false);
    expect(test.acknowledge).not.toHaveBeenCalled();

    // Simula a conclusão da transação financeira.
    finishProcessing({ alreadyProcessed: false });

    await runningCycle;
    await shutdown;

    expect(test.acknowledge).toHaveBeenCalledWith('receipt-123');
    expect(shutdownFinished).toBe(true);

    // Depois do shutdown, nenhuma nova leitura deve começar.
    await test.poll();

    expect(test.receive).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { EntityManager } from '@mikro-orm/postgresql';

import { AppModule } from '../src/app.module.js';
import { WageringService } from '../src/wagering/wagering.service.js';

type DatabaseResult = {
  balance: string;
  transactions: number;
  ledgerEntries: number;
  inboxMessages: number;
  outboxEvents: number;
};

describe('Inbox atomicity integration tests', () => {
  it('should rollback inbox, wallet, ledger and outbox together', async () => {
    // Cria dados exclusivos para não interferir em outros testes.
    const playerId = `rollback-test-${randomUUID()}`;
    const messageId = randomUUID();
    const idempotencyKey = randomUUID();

    const walletResponse = await fetch('http://localhost:3000/wallets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        playerId,
        initialBalance: {
          amount: '100.00',
          currency: 'BRL',
        },
      }),
    });

    expect(walletResponse.ok).toBe(true);

    const wallet = (await walletResponse.json()) as {
      id: string;
    };

    // Inicia o contexto NestJS usando os providers reais.
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });

    try {
      const em = app.get(EntityManager);
      const wagering = app.get(WageringService);

      const transaction = {
        providerId: 'atomicity-test',
        externalTransactionId: randomUUID(),
        playerId,
        walletId: wallet.id,
        roundId: randomUUID(),
        gameId: 'atomicity-game',
        kind: 'BET',
        money: {
          amount: '30.00',
          currency: 'BRL',
        },
      };

      // Executa a BET pela inbox, mas força rollback externo.
      await expect(
        em.transactional(async () => {
          const result = await wagering.processFromQueue(
            messageId,
            transaction,
            idempotencyKey,
          );

          expect(result.alreadyProcessed).toBe(false);

          // Simula falha após o processamento financeiro.
          throw new Error('FORCED_ROLLBACK_TEST');
        }),
      ).rejects.toThrow('FORCED_ROLLBACK_TEST');

      // Confere os dados persistidos após o rollback.
      const rows = await em.getConnection().execute<DatabaseResult[]>(
        `
        SELECT
          (SELECT balance FROM wallets WHERE id = ?) AS balance,
          (
            SELECT COUNT(*)::int
            FROM wager_transactions
            WHERE idempotency_key = ?
          ) AS transactions,
          (
            SELECT COUNT(*)::int
            FROM wallet_ledger_entries
            WHERE wallet_id = ?
          ) AS "ledgerEntries",
          (
            SELECT COUNT(*)::int
            FROM inbox_messages
            WHERE message_id = ?
          ) AS "inboxMessages",
          (
            SELECT COUNT(*)::int
            FROM outbox_messages
            WHERE aggregate_id = ?
          ) AS "outboxEvents"
        `,
        [wallet.id, idempotencyKey, wallet.id, messageId, wallet.id],
      );

      const state = rows[0];

      expect(state).toBeDefined();

      // Saldo permanece intacto.
      expect(state.balance).toBe('100.00');

      // Nenhuma BET foi confirmada.
      expect(state.transactions).toBe(0);

      // Apenas o crédito inicial permanece no ledger.
      expect(state.ledgerEntries).toBe(1);

      // Inbox e outbox também foram revertidas.
      expect(state.inboxMessages).toBe(0);
      expect(state.outboxEvents).toBe(0);
    } finally {
      await app.close();
    }
  }, 30000);
});

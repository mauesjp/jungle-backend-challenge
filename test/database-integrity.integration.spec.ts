import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import 'dotenv/config';

describe('Database financial integrity', () => {
  it('should preserve ledger constraints, immutability trigger and reversal index', async () => {
    const client = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });

    await client.connect();

    try {
      const constraints = await client.query<{ conname: string }>(`
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'wallet_ledger_entries'::regclass
          AND conname IN (
            'ledger_amount_positive',
            'ledger_balances_nonnegative',
            'ledger_direction_valid',
            'ledger_balance_consistent'
          )
      `);

      expect(constraints.rows.map((row) => row.conname).sort()).toEqual(
        [
          'ledger_amount_positive',
          'ledger_balances_nonnegative',
          'ledger_direction_valid',
          'ledger_balance_consistent',
        ].sort(),
      );

      const index = await client.query<{ indexname: string }>(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'wager_transactions'
          AND indexname = 'uq_processed_reversal_per_kind'
      `);

      expect(index.rowCount).toBe(1);

      const trigger = await client.query<{ tgname: string }>(`
        SELECT tgname
        FROM pg_trigger
        WHERE tgrelid = 'wallet_ledger_entries'::regclass
          AND tgname = 'ledger_immutable_trigger'
          AND NOT tgisinternal
      `);

      expect(trigger.rowCount).toBe(1);

      // Confirma que a função efetivamente bloqueia alterações.
      const functionBody = await client.query<{ definition: string }>(`
        SELECT pg_get_functiondef(
          'prevent_ledger_modification()'::regprocedure
        ) AS definition
      `);

      expect(functionBody.rows[0].definition).toContain('RAISE EXCEPTION');
    } finally {
      await client.end();
    }
  });
});

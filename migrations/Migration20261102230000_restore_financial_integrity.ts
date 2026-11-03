import { Migration } from '@mikro-orm/migrations';

export class Migration20261102230000_restore_financial_integrity extends Migration {
  override name = 'Migration20261102230000_restore_financial_integrity';

  override up(): void {
    // Impede duas reversões processadas do mesmo tipo
    // para a mesma transação original.
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_processed_reversal_per_kind
      ON wager_transactions (reference_transaction_id, kind)
      WHERE status = 'PROCESSED'
        AND kind IN ('REFUND', 'ROLLBACK')
        AND reference_transaction_id IS NOT NULL;
    `);

    // Garante valores positivos no ledger.
    this.addSql(`
      ALTER TABLE wallet_ledger_entries
      ADD CONSTRAINT ledger_amount_positive
      CHECK (amount > 0);
    `);

    // Impede saldos negativos nos lançamentos.
    this.addSql(`
      ALTER TABLE wallet_ledger_entries
      ADD CONSTRAINT ledger_balances_nonnegative
      CHECK (balance_before >= 0 AND balance_after >= 0);
    `);

    // Aceita apenas as direções financeiras previstas.
    this.addSql(`
      ALTER TABLE wallet_ledger_entries
      ADD CONSTRAINT ledger_direction_valid
      CHECK (direction IN ('DEBIT', 'CREDIT'));
    `);

    // Verifica se o saldo após a operação corresponde
    // exatamente ao valor debitado ou creditado.
    this.addSql(`
      ALTER TABLE wallet_ledger_entries
      ADD CONSTRAINT ledger_balance_consistent
      CHECK (
        (direction = 'CREDIT'
          AND balance_after = balance_before + amount)
        OR
        (direction = 'DEBIT'
          AND balance_after = balance_before - amount)
      );
    `);

    // Restaura a função original de imutabilidade.
    this.addSql(`
      CREATE OR REPLACE FUNCTION prevent_ledger_modification()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Ledger entries are immutable';
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Remove eventual trigger antigo antes de recriá-lo.
    this.addSql(`
      DROP TRIGGER IF EXISTS ledger_immutable_trigger
      ON wallet_ledger_entries;
    `);

    this.addSql(`
      CREATE TRIGGER ledger_immutable_trigger
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW
      EXECUTE FUNCTION prevent_ledger_modification();
    `);
  }

  override down(): void {
    this.addSql(`
      DROP TRIGGER IF EXISTS ledger_immutable_trigger
      ON wallet_ledger_entries;
    `);

    this.addSql(`
      DROP INDEX IF EXISTS uq_processed_reversal_per_kind;
    `);

    this.addSql(`
      ALTER TABLE wallet_ledger_entries
      DROP CONSTRAINT IF EXISTS ledger_amount_positive,
      DROP CONSTRAINT IF EXISTS ledger_balances_nonnegative,
      DROP CONSTRAINT IF EXISTS ledger_direction_valid,
      DROP CONSTRAINT IF EXISTS ledger_balance_consistent;
    `);

    // Não removemos a função: outras migrations
    // também podem depender dela.
  }
}

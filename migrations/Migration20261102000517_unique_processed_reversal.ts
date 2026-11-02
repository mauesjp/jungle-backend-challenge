import { Migration } from '@mikro-orm/migrations';

export class Migration20261102000517_unique_processed_reversal extends Migration {
  override name = 'Migration20261102000517_unique_processed_reversal';

  override up(): void | Promise<void> {
    this.addSql(`
      CREATE UNIQUE INDEX uq_processed_reversal_per_kind
      ON wager_transactions (
        reference_transaction_id,
        kind
      )
      WHERE status = 'PROCESSED'
        AND kind IN ('REFUND', 'ROLLBACK')
        AND reference_transaction_id IS NOT NULL;
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`
      DROP INDEX IF EXISTS uq_processed_reversal_per_kind;
    `);
  }
}

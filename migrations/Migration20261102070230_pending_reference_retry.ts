import { Migration } from '@mikro-orm/migrations';

export class Migration20261102070230_pending_reference_retry extends Migration {

  override name = 'Migration20261102070230_pending_reference_retry';

  override up(): void | Promise<void> {
    this.addSql(`drop index "uq_processed_reversal_per_kind";`);
    this.addSql(`alter table "wager_transactions" add "retry_attempts" int not null default 0, add "next_retry_at" timestamptz null;`);

    this.addSql(`alter table "wallet_ledger_entries" drop constraint "ledger_amount_positive";`);
    this.addSql(`alter table "wallet_ledger_entries" drop constraint "ledger_balance_consistent";`);
    this.addSql(`alter table "wallet_ledger_entries" drop constraint "ledger_balances_nonnegative";`);
    this.addSql(`alter table "wallet_ledger_entries" drop constraint "ledger_direction_valid";`);
    this.addSql(`drop trigger if exists "ledger_immutable_trigger" on "wallet_ledger_entries";`);
    this.addSql(`drop function if exists "wallet_ledger_entries_ledger_immutable_trigger_fn"();`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" drop column "retry_attempts", drop column "next_retry_at";`);
    this.addSql(`create unique index "uq_processed_reversal_per_kind" on "wager_transactions" ("reference_transaction_id", "kind") where ((status)::text = 'PROCESSED'::text) AND ((kind)::text = ANY ((ARRAY['REFUND'::character varying, 'ROLLBACK'::character varying])::text[])) AND (reference_transaction_id IS NOT NULL);`);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_amount_positive" check (amount > 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_balance_consistent" check (((direction = 'CREDIT'::text) AND (balance_after = (balance_before + amount))) OR ((direction = 'DEBIT'::text) AND (balance_after = (balance_before - amount))));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_balances_nonnegative" check ((balance_before >= 0) AND (balance_after >= 0));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_direction_valid" check ("direction" in ('DEBIT', 'CREDIT'));`);
    this.addSql(`create or replace function "wallet_ledger_entries_ledger_immutable_trigger_fn"() returns trigger as \$\$ begin ; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "ledger_immutable_trigger" BEFORE DELETE OR UPDATE on "wallet_ledger_entries" for each ROW execute function "wallet_ledger_entries_ledger_immutable_trigger_fn"();`);
  }

}

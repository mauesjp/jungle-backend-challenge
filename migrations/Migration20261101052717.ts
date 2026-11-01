
import { Migration } from '@mikro-orm/migrations';

export class Migration20261101052717 extends Migration {
  override name = 'Migration20261101052717';

  override up(): void {
    // Wager transactions
    this.addSql(`
      create table "wager_transactions" (
        "id" uuid not null,
        "provider_id" varchar(100) not null,
        "external_transaction_id" varchar(255) not null,
        "idempotency_key" varchar(255) not null,
        "payload_hash" varchar(64) not null,
        "wallet_id" uuid not null,
        "player_id" varchar(255) not null,
        "round_id" varchar(255) not null,
        "game_id" varchar(255) not null,
        "kind" varchar(30) not null,
        "status" varchar(30) not null default 'PENDING',
        "amount" numeric(20,2) not null,
        "currency" varchar(3) not null,
        "reference_transaction_id" uuid null,
        "reference_external_transaction_id" varchar(255) null,
        "result_payload" jsonb null,
        "created_at" timestamptz not null,
        "updated_at" timestamptz not null,
        "failure_code" varchar(100) null,
        "processed_at" timestamptz null,
        primary key ("id")
      );
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_idempotency_key_unique"
      unique ("idempotency_key");
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_provider_id_external_transaction_id_unique"
      unique ("provider_id", "external_transaction_id");
    `);

    // Wallet ledger
    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "transaction_id" uuid not null,
        "direction" varchar(10) not null,
        "amount" numeric(20,2) not null,
        "balance_before" numeric(20,2) not null,
        "balance_after" numeric(20,2) not null,
        "created_at" timestamptz not null,
        primary key ("id")
      );
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_wallet_id_transaction_id_unique"
      unique ("wallet_id", "transaction_id");
    `);

    // Foreign keys
    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_wallet_id_foreign"
      foreign key ("wallet_id") references "wallets" ("id");
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_wallet_id_foreign"
      foreign key ("wallet_id") references "wallets" ("id");
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_transaction_id_foreign"
      foreign key ("transaction_id")
      references "wager_transactions" ("id");
    `);

    // Financial constraints
    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "ledger_amount_positive"
      check ("amount" > 0);
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "ledger_balances_nonnegative"
      check ("balance_before" >= 0 and "balance_after" >= 0);
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "ledger_direction_valid"
      check ("direction" in ('DEBIT', 'CREDIT'));
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "ledger_balance_consistent"
      check (
        ("direction" = 'CREDIT'
          and "balance_after" = "balance_before" + "amount")
        or
        ("direction" = 'DEBIT'
          and "balance_after" = "balance_before" - "amount")
      );
    `);

    // Immutable ledger
    this.addSql(`
      create function prevent_ledger_modification()
      returns trigger as $$
      begin
        raise exception 'Ledger entries are immutable';
      end;
      $$ language plpgsql;
    `);

    this.addSql(`
      create trigger ledger_immutable_trigger
      before update or delete on "wallet_ledger_entries"
      for each row
      execute function prevent_ledger_modification();
    `);
  }

  override down(): void {
    this.addSql(`
      drop table if exists "wallet_ledger_entries";
    `);

    this.addSql(`
      drop table if exists "wager_transactions";
    `);

    this.addSql(`
      drop function if exists prevent_ledger_modification();
    `);
  }
}

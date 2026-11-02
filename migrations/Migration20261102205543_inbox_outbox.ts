import { Migration } from '@mikro-orm/migrations';

export class Migration20261102205543_inbox_outbox extends Migration {

  override name = 'Migration20261102205543_inbox_outbox';

  override up(): void | Promise<void> {
    this.addSql(`create table "inbox_messages" ("id" uuid not null, "consumer_name" varchar(100) not null, "message_id" varchar(255) not null, "payload_hash" varchar(64) not null, "received_at" timestamptz not null, "processed_at" timestamptz null, primary key ("id"));`);
    this.addSql(`alter table "inbox_messages" add constraint "inbox_messages_consumer_name_message_id_unique" unique ("consumer_name", "message_id");`);

    this.addSql(`create table "outbox_messages" ("id" uuid not null, "aggregate_id" uuid not null, "event_type" varchar(100) not null, "payload" jsonb not null, "attempts" int not null default 0, "occurred_at" timestamptz not null, "next_attempt_at" timestamptz null, "published_at" timestamptz null, primary key ("id"));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "inbox_messages" cascade;`);
    this.addSql(`drop table if exists "outbox_messages" cascade;`);
  }

}

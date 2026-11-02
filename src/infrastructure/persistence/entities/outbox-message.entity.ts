import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { randomUUID } from 'node:crypto';

@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property({ type: 'uuid' })
  aggregateId!: string;

  @Property({ type: 'string', length: 100 })
  eventType!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Property({ type: 'integer', default: 0 })
  attempts: number = 0;

  @Property({ type: 'datetime' })
  occurredAt: Date = new Date();

  @Property({ type: 'datetime', nullable: true })
  nextAttemptAt?: Date;

  @Property({ type: 'datetime', nullable: true })
  publishedAt?: Date;
}

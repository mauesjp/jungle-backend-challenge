import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { randomUUID } from 'node:crypto';

@Entity({ tableName: 'inbox_messages' })
@Unique({ properties: ['consumerName', 'messageId'] })
export class InboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property({ type: 'string', length: 100 })
  consumerName!: string;

  @Property({ type: 'string', length: 255 })
  messageId!: string;

  @Property({ type: 'string', length: 64 })
  payloadHash!: string;

  @Property({ type: 'datetime' })
  receivedAt: Date = new Date();

  @Property({ type: 'datetime', nullable: true })
  processedAt?: Date;
}

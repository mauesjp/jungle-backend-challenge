import { Module } from '@nestjs/common';

import { SqsService } from './sqs.service.js';
import { SqsConsumerService } from './sqs-consumer.service.js';
import { OutboxPublisherService } from './outbox-publisher.service.js';

import { WageringService } from '../../wagering/wagering.service.js';

@Module({
  providers: [
    SqsService,
    SqsConsumerService,
    OutboxPublisherService,
    WageringService,
  ],
  exports: [SqsService],
})
export class MessagingModule {}

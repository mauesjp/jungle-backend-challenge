import { Injectable, OnModuleDestroy } from '@nestjs/common';

import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

@Injectable()
export class SqsService implements OnModuleDestroy {
  private readonly client: SQSClient;

  readonly transactionsQueueUrl: string;
  readonly deadLetterQueueUrl: string;

  constructor() {
    const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';

    const region = process.env.AWS_REGION ?? 'us-east-1';

    this.client = new SQSClient({
      region,
      endpoint,
      credentials: {
        accessKeyId: 'test',
        secretAccessKey: 'test',
      },
    });

    this.transactionsQueueUrl =
      process.env.SQS_TRANSACTIONS_URL ??
      `${endpoint}/000000000000/wager-transactions.fifo`;

    this.deadLetterQueueUrl =
      process.env.SQS_DLQ_URL ??
      `${endpoint}/000000000000/wager-transactions-dlq.fifo`;
  }

  async send(
    message: Record<string, unknown>,
    groupId: string,
    deduplicationId: string,
  ): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.transactionsQueueUrl,
        MessageBody: JSON.stringify(message),
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
      }),
    );
  }

  async receive() {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.transactionsQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 10,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );

    return result.Messages ?? [];
  }

  async acknowledge(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.transactionsQueueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async checkConnection(): Promise<boolean> {
    try {
      await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.transactionsQueueUrl,
          AttributeNames: ['QueueArn'],
        }),
      );

      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy() {
    this.client.destroy();
  }
}

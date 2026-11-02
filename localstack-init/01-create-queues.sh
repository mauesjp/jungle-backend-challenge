
#!/bin/bash
set -e
export LOCALSTACK_HOST=localstack

echo "Creating Jungle Gaming queues..."

DLQ_URL=$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"true"}' \
  --query 'QueueUrl' \
  --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)

REDRIVE_POLICY=$(printf \
  '{"deadLetterTargetArn":"%s","maxReceiveCount":"5"}' \
  "$DLQ_ARN")

ATTRIBUTES=$(printf \
  '{"FifoQueue":"true","ContentBasedDeduplication":"true","VisibilityTimeout":"30","RedrivePolicy":%s}' \
  "$(printf '%s' "$REDRIVE_POLICY" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "$ATTRIBUTES"

awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"true"}'

echo "Queues created successfully."

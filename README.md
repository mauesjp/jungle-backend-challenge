# Jungle Gaming — Backend Challenge

Backend implementation of a financial wagering system using NestJS, TypeScript, PostgreSQL, MikroORM, and AWS SQS (emulated locally with LocalStack).

The project handles wallet balances, wagering transactions, financial reversals, idempotency, concurrent requests, asynchronous message processing, and event publication.

## Tech Stack

- NestJS and TypeScript
- Bun
- PostgreSQL 17
- MikroORM 7
- Docker Compose
- LocalStack / AWS SQS FIFO
- Decimal.js
- Vitest

## Requirements

Install the following tools:

- Docker with Docker Compose
- Bun
- Git

## Getting Started

Clone the repository and install dependencies:

```bash
git clone https://github.com/mauesjp/jungle-backend-challenge.git
cd jungle-backend-challenge
bun install --frozen-lockfile
```

Create the environment file from the provided example.

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

On Linux or macOS:

```bash
cp .env.example .env
```

The example configuration is intended for local development. PostgreSQL and LocalStack run in Docker, while the NestJS application runs on the host.

Start the infrastructure:

```bash
docker compose up -d setup
```

This starts PostgreSQL and LocalStack, then runs the initialization service that creates the SQS queues.

Apply the database migrations:

```bash
bunx mikro-orm migration:up
```

Start the application:

```bash
bun run start:dev
```

The API is available at `http://localhost:3000` by default.

## Health Checks

Liveness:

```text
GET /health/live
```

Readiness:

```text
GET /health/ready
```

Readiness verifies connectivity with PostgreSQL and the transactions SQS queue. It returns HTTP 503 when a required dependency is unavailable.

## Main API Endpoints

| Method | Endpoint                                                              | Purpose                             |
| ------ | --------------------------------------------------------------------- | ----------------------------------- |
| POST   | `/wallets`                                                            | Create a wallet                     |
| GET    | `/wallets/:walletId`                                                  | Retrieve a wallet                   |
| GET    | `/wallets/:walletId/ledger`                                           | Retrieve wallet ledger entries      |
| POST   | `/wallets/:walletId/reconciliation`                                   | Reconcile wallet balance and ledger |
| POST   | `/wagering/transactions`                                              | Process a wagering transaction      |
| GET    | `/wagering/transactions/:transactionId`                               | Retrieve a transaction              |
| GET    | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Retrieve a provider transaction     |
| GET    | `/health/live`                                                        | Liveness check                      |
| GET    | `/health/ready`                                                       | Dependency readiness check          |

## Example: Create a Wallet

```json
{
  "playerId": "player-001",
  "initialBalance": {
    "amount": "100.00",
    "currency": "BRL"
  }
}
```

Send this JSON to `POST /wallets`.

The response includes a generated wallet ID, which is required when submitting wagering transactions.

## Example: Place a Bet

Send a POST request to `/wagering/transactions` with the header:

```text
Idempotency-Key: unique-request-key-001
```

Example body:

```json
{
  "providerId": "provider-001",
  "externalTransactionId": "bet-001",
  "playerId": "player-001",
  "walletId": "<wallet-id-from-create-response>",
  "roundId": "round-001",
  "gameId": "game-001",
  "kind": "BET",
  "money": {
    "amount": "30.00",
    "currency": "BRL"
  }
}
```

The API returns the transaction identifier, processing status, resulting wallet balance, and whether the request was an idempotent replay.

## Supported Operations

- **BET:** Debit the wallet if sufficient funds are available.
- **WIN:** Credit the wallet.
- **LOSS:** Record a loss without changing the wallet balance; zero amount is supported.
- **REFUND:** Reverse a referenced BET.
- **ROLLBACK:** Reverse an eligible referenced transaction.

Financial reversal operations validate their references and prevent duplicate processed reversals.

When a required reversal reference is missing, the transaction enters `PENDING_REFERENCE`. A background worker attempts to resolve it later, using bounded retries and exponential backoff.

## Financial Consistency

Financial values use Decimal.js and are stored in PostgreSQL numeric columns.

Wallet updates execute inside database transactions with pessimistic row locking. This helps serialize concurrent operations against the same wallet.

The database records an immutable ledger entry for each financial balance movement.

Idempotency is enforced using request identifiers, payload hashes, and database uniqueness constraints.

## SQS Messaging

The local environment creates three FIFO queues:

- `wager-transactions.fifo`
- `wager-transactions-dlq.fifo`
- `wager-events.fifo`

The transactions queue receives messages containing an `idempotencyKey` and a `transaction` payload.

The consumer records completed messages in an inbox table and acknowledges SQS messages only after successful processing.

Failed messages are retried according to the SQS visibility timeout and redrive policy. Messages exceeding the configured receive count are transferred to the DLQ.

## Transactional Outbox

Business events are persisted in the same database transaction as the related wagering state changes.

An asynchronous publisher sends these events to `wager-events.fifo`.

Supported event types:

- `WagerTransactionProcessed`
- `WagerTransactionRejected`
- `WalletBalanceChanged`
- `WagerTransactionPendingReference`

The outbox retries failed publications with exponential backoff.

Event delivery follows **at-least-once semantics**. Consumers must handle possible duplicate deliveries.

## Testing

Start PostgreSQL, LocalStack, and the application before running integration tests.

Run all tests:

```bash
bun run test
```

Run TypeScript validation:

```bash
bunx tsc --noEmit
```

The validated suite contains 18 tests across four test files.

Coverage includes money calculations, idempotency, concurrent bets, concurrent refunds, pending-reference recovery, zero-value LOSS, and transactional rollback across inbox and financial persistence.

Additional manual tests were performed for multiple running API instances, SQS redelivery and DLQ, outbox recovery after SQS downtime, and readiness checks.

## Running Multiple Instances

The application can be started on separate ports while sharing the same PostgreSQL database.

For example, on Windows PowerShell, in a separate terminal:

```powershell
$env:PORT = "3001"
bun run start
```

Database locks and uniqueness constraints provide cross-process financial coordination.

## Known Limitations

- The environment is intended for local evaluation, not production deployment.
- Docker Compose provisions infrastructure; the application runs separately on the host.
- The SQS initialization service must be executed again if LocalStack is restarted and its queues are lost.
- The outbox provides at-least-once delivery, not exactly-once delivery.
- Background workers stop scheduling new cycles during shutdown but do not explicitly await completion of work already in progress.
- Observability currently relies primarily on NestJS logs and health endpoints; a production-grade metrics/tracing stack is not included.

## Architecture

See `ARCHITECTURE.md` for financial transaction flows, concurrency decisions, retry behavior, inbox/outbox guarantees, and architectural trade-offs.

## Author

João Pedro Maués

Backend technical challenge implementation.

## SQS Request Contract

The transactions consumer accepts the following message envelope:

```json
{
  "messageId": "message-001",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-11-02T20:00:00.000Z",
  "data": {
    "providerId": "provider-001",
    "externalTransactionId": "bet-001",
    "idempotencyKey": "unique-request-001",
    "playerId": "player-001",
    "walletId": "wallet-uuid",
    "roundId": "round-001",
    "gameId": "game-001",
    "kind": "BET",
    "money": {
      "amount": "30.00",
      "currency": "BRL"
    }
  }
}
```

The business `messageId` is used by the transactional inbox. Failed messages are not acknowledged and remain subject to SQS redelivery and DLQ handling.

## Observability

The application uses structured JSON logging.

`GET /metrics` exposes local, in-memory counters for SQS processing, duplicate messages, failures, outbox publications, and pending-reference retry exceptions.

It also exposes processing-time and outbox-delay statistics.

Metrics are reset when the application restarts and are not aggregated across instances. The metrics endpoint is intended for local evaluation and should be protected in a production environment.

## Graceful Shutdown

The application handles SIGINT and SIGTERM through NestJS shutdown hooks.

The SQS consumer, outbox publisher, and pending-reference worker stop scheduling new work and await their currently running cycles before completing shutdown.

This reduces interruptions during ordinary shutdown, but does not prevent forced termination or eliminate at-least-once delivery.

## Additional Validation

The automated suite contains 38 passing tests across eight test files.

Manual verification included three separate API instances sharing PostgreSQL. Three concurrent BET requests of BRL 80.00 against a BRL 100.00 wallet produced one PROCESSED result, two REJECTED results, and a final balance of BRL 20.00.

The outbox was also observed operating across multiple instances, with no unpublished events remaining at the time of inspection.

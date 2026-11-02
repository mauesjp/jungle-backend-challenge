# Architecture — Jungle Gaming Backend Challenge

## Overview

The system implements wallet and wagering transaction processing with a focus on financial consistency, idempotency, concurrency control, and failure recovery.

The application follows a modular structure separating domain concepts, business processing, persistence, and messaging infrastructure.

## Main Components

### Wallets

Wallets store player identity, currency, current balance, and a version number.

Each balance-changing operation produces a corresponding immutable ledger entry.

The reconciliation endpoint compares wallet information against ledger records.

### Wagering Service

`WageringService` is responsible for applying wagering rules and orchestrating database transactions.

It supports BET, WIN, LOSS, REFUND, and ROLLBACK operations.

Requests are validated before financial processing. Reversal operations additionally validate references to existing transactions.

### PostgreSQL and MikroORM

PostgreSQL is the authoritative source of financial state.

MikroORM handles entities and database transactions, while migrations explicitly define and evolve the schema.

Financial processing uses pessimistic row locks on wallets.

### SQS Consumer and Inbox

The SQS consumer receives transaction requests from a FIFO queue.

The inbox records successfully completed message processing and supports redelivery protection.

A message is acknowledged after successful database processing. Failures leave it available for retry under the SQS visibility-timeout policy.

### Transactional Outbox

Business events are inserted into the outbox within the same database transaction as the wagering operation.

The publisher selects eligible outbox records, reserves them temporarily, and sends the event to the SQS events queue.

Successful publication updates `published_at`. Failed publication schedules a retry.

### Pending Reference Worker

Some reversals may arrive before their referenced transaction exists.

Such operations are stored with status `PENDING_REFERENCE`.

The worker scans eligible pending transactions every three seconds, selecting up to 20 per cycle.

Processing uses the same wagering rules and wallet locks as normal requests.

A bounded retry policy prevents indefinite retries.

## Financial Transaction Flow

1. Validate the request and idempotency key.
2. Normalize and hash the transaction payload.
3. Check for an existing matching transaction.
4. Open a PostgreSQL transaction.
5. Lock the wallet pessimistically.
6. Recheck idempotency after acquiring the lock.
7. Apply the business rules.
8. Update the wallet balance when applicable.
9. Persist the transaction, ledger entry, and outbox events.
10. Commit the database transaction.
11. Publish outbox events asynchronously.

For successful financial operations, state changes and their ledger records share the same transaction boundary.

## Concurrency Control

Concurrent requests can target the same wallet from independent application processes.

The implementation uses a PostgreSQL pessimistic write lock when loading the wallet.

This serializes financial modifications for that wallet. The second transaction waits for the first to release the lock and then evaluates the latest committed balance.

A manually validated scenario submitted two simultaneous BET requests of BRL 80.00 to a wallet containing BRL 100.00 from two separate API instances.

Observed outcome:

- One BET was processed.
- One BET was rejected.
- Final wallet balance was BRL 20.00.
- Exactly one BET debit was recorded in the ledger.

Database uniqueness constraints provide an additional layer of protection against conflicting transaction identifiers and duplicate processed reversals.

## Idempotency

A wagering request contains an `Idempotency-Key`.

The system also identifies provider transactions using the provider ID and external transaction ID.

A SHA-256 hash derived from the normalized request payload is stored alongside the transaction.

A retry with matching identifiers and payload returns the existing transaction response.

A conflicting payload using an existing identifier is rejected.

Idempotency checks are performed before processing and again after acquiring the wallet lock.

This protects both ordinary retries and concurrent duplicate requests.

## Reversal Handling

REFUND and ROLLBACK operations reference earlier transactions.

The service verifies the reference, player, wallet, currency, round, game, transaction type, and amount.

Missing references can result in `PENDING_REFERENCE`, allowing the original transaction to arrive later.

The background worker retries these operations.

If the reference remains unavailable after the configured retry limit, the transaction is rejected.

Processed reversals are protected by database constraints to prevent duplicate financial effects.

## Inbox Atomicity

SQS messages are processed through `processFromQueue()`.

The method uses a database transaction to insert the inbox record, process the financial operation, and mark the message as completed.

MikroORM transactional context allows the nested financial operation to participate in the surrounding transaction.

A dedicated integration test forces an exception after financial processing but before the outer transaction commits.

The verified result is that the BET, its new ledger entry, inbox record, and outbox events do not remain committed; the wallet balance is preserved.

This demonstrates transactional rollback for the tested failure scenario.

## Outbox Event Publication

The outbox publisher polls periodically for unpublished events.

It uses PostgreSQL `FOR UPDATE SKIP LOCKED` within an atomic reservation query and a temporary retry timestamp.

Each published SQS FIFO message uses:

- Wallet ID as the message group ID.
- Outbox event ID as the deduplication ID.
- Serialized event envelope as the message body.

The envelope contains the event ID, event type, aggregate ID, correlation ID, causation ID, timestamp, version, and event data.

Failed publications are retried using exponential backoff capped at 60 seconds.

The outbox is designed for at-least-once publication. A message may be sent more than once if failure occurs after SQS accepts it but before the database marks it published.

Downstream consumers must remain idempotent.

## SQS Failure Handling

The transactions queue uses a visibility timeout of 30 seconds and a dead-letter queue configured with a maximum receive count of five.

The consumer does not acknowledge messages that fail processing.

A manual test demonstrated repeated delivery of a failing message and subsequent movement to the configured DLQ.

A separate test demonstrated that a financial transaction already processed through the HTTP API was not debited a second time when submitted through SQS with the same business idempotency key.

## Health Checks

Two health endpoints are provided:

- `/health/live` reports process liveness.
- `/health/ready` checks PostgreSQL and SQS availability.

The readiness endpoint returns HTTP 503 when a required dependency is unavailable.

LocalStack shutdown and recovery were manually verified.

## Background Worker Lifecycle

The SQS consumer, outbox publisher, and pending-reference worker use periodic or continuous polling.

Each worker prevents overlapping processing cycles inside its own application instance.

Cross-instance consistency relies on database transactions, row locks, uniqueness constraints, and stable messaging identifiers.

During application shutdown, timers are cleared to stop scheduling new work.

An explicit graceful-drain mechanism for in-flight worker operations is not implemented.

## Verification

The project includes unit and integration tests validating:

- Decimal-based monetary operations.
- Wagering idempotency.
- Concurrent transaction handling.
- Concurrent duplicate request handling.
- Refund and rollback rules.
- Pending-reference recovery.
- Zero-value LOSS processing.
- Transactional rollback across inbox and financial records.

The validated suite contains 18 passing tests.

Additional manual tests covered separate application instances, SQS redelivery and DLQ behavior, outbox recovery, and health-check dependency failures.

## Trade-offs and Limitations

**Polling-based workers:** Simple to understand and operate locally, but introduce polling overhead and latency.

**PostgreSQL wallet locking:** Provides clear consistency guarantees for wallet updates, but concurrent requests against one wallet are serialized.

**Transactional outbox:** Prevents committing a financial change without persisting its intended event, but does not guarantee exactly-once delivery.

**Temporary outbox reservations:** Reduce duplicate publication between instances, but a reservation can expire while a slow publisher is still working.

**LocalStack:** Makes SQS behavior reproducible for development but is not a complete substitute for production AWS validation.

**Observability:** Logging and health checks are implemented; richer distributed tracing, alerting, and operational dashboards remain future work.

## Potential Improvements

Future work could include:

- Automated integration tests for SQS redelivery and DLQ handling.
- Graceful shutdown that waits for in-flight worker operations.
- Distributed worker coordination and stronger outbox ownership guarantees.
- Structured metrics and distributed tracing.
- Containerization of the NestJS application itself.
- Broader load testing and failure-injection coverage.

These improvements are outside the currently validated scope.

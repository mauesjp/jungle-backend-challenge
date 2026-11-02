import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

const BASE_URL = 'http://localhost:3000';

type Money = {
  amount: string;
  currency: string;
};

type WalletResponse = {
  id: string;
  playerId: string;
  balance: Money;
};

type TransactionResponse = {
  transactionId: string;
  status: string;
  balance: Money;
  idempotentReplay: boolean;
};

type Kind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

type TransactionInput = {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: Kind;
  money: Money;
  referenceExternalTransactionId?: string;
};

async function post<T>(
  path: string,
  body: object,
  idempotencyKey?: string,
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`HTTP ${response.status}: ${error}`);
  }

  return (await response.json()) as T;
}

async function createWallet(initialAmount = '100.00'): Promise<WalletResponse> {
  return post<WalletResponse>('/wallets', {
    playerId: `test-${randomUUID()}`,
    initialBalance: {
      amount: initialAmount,
      currency: 'BRL',
    },
  });
}

function createTransaction(
  wallet: WalletResponse,
  kind: Kind,
  amount: string,
  options: {
    roundId?: string;
    referenceExternalTransactionId?: string;
  } = {},
): TransactionInput {
  return {
    providerId: 'integration-tests',
    externalTransactionId: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: options.roundId ?? randomUUID(),
    gameId: 'test-game',
    kind,
    money: {
      amount,
      currency: 'BRL',
    },
    ...(options.referenceExternalTransactionId
      ? {
          referenceExternalTransactionId:
            options.referenceExternalTransactionId,
        }
      : {}),
  };
}

async function submit(
  transaction: TransactionInput,
  key = randomUUID(),
): Promise<TransactionResponse> {
  return post<TransactionResponse>('/wagering/transactions', transaction, key);
}

describe('Wagering integration tests', () => {
  it('should not debit the same bet twice', async () => {
    const wallet = await createWallet();

    const bet = createTransaction(wallet, 'BET', '30.00');
    const key = randomUUID();

    const first = await submit(bet, key);
    const replay = await submit(bet, key);

    expect(first.status).toBe('PROCESSED');
    expect(first.balance.amount).toBe('70.00');
    expect(first.idempotentReplay).toBe(false);

    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.amount).toBe('70.00');
  });

  it('should process only one of two concurrent bets of 80', async () => {
    const wallet = await createWallet();

    const betA = createTransaction(wallet, 'BET', '80.00');
    const betB = createTransaction(wallet, 'BET', '80.00');

    const results = await Promise.all([submit(betA), submit(betB)]);

    expect(
      results.filter((result) => result.status === 'PROCESSED'),
    ).toHaveLength(1);

    expect(
      results.filter((result) => result.status === 'REJECTED'),
    ).toHaveLength(1);

    // O resultado da transação rejeitada deve refletir
    // o saldo que permaneceu na carteira.
    expect(
      results.find((result) => result.status === 'REJECTED')?.balance.amount,
    ).toBe('20.00');
  });

  it('should not duplicate a debit across 50 concurrent requests', async () => {
    const wallet = await createWallet();

    const bet = createTransaction(wallet, 'BET', '30.00');
    const key = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 50 }, () => submit(bet, key)),
    );

    expect(results.every((result) => result.status === 'PROCESSED')).toBe(true);

    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);

    expect(results.every((result) => result.balance.amount === '70.00')).toBe(
      true,
    );

    expect(
      results.filter((result) => result.idempotentReplay === false),
    ).toHaveLength(1);
  }, 30000);

  it('should process a refund and a win rollback correctly', async () => {
    const wallet = await createWallet();
    const roundId = randomUUID();

    const bet = createTransaction(wallet, 'BET', '30.00', {
      roundId,
    });

    const betResult = await submit(bet);
    expect(betResult.balance.amount).toBe('70.00');

    const win = createTransaction(wallet, 'WIN', '50.00', {
      roundId,
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    const winResult = await submit(win);
    expect(winResult.status).toBe('PROCESSED');
    expect(winResult.balance.amount).toBe('120.00');

    const refund = createTransaction(wallet, 'REFUND', '30.00', {
      roundId,
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    const refundResult = await submit(refund);
    expect(refundResult.status).toBe('PROCESSED');
    expect(refundResult.balance.amount).toBe('150.00');

    const rollback = createTransaction(wallet, 'ROLLBACK', '50.00', {
      roundId,
      referenceExternalTransactionId: win.externalTransactionId,
    });

    const rollbackResult = await submit(rollback);

    expect(rollbackResult.status).toBe('PROCESSED');
    expect(rollbackResult.balance.amount).toBe('100.00');
  });

  it('should prevent concurrent refunds of the same bet', async () => {
    const wallet = await createWallet('100.00');
    const roundId = randomUUID();

    const bet = createTransaction(wallet, 'BET', '30.00', {
      roundId,
    });

    const betResult = await submit(bet);

    expect(betResult.status).toBe('PROCESSED');
    expect(betResult.balance.amount).toBe('70.00');

    const refundA = createTransaction(wallet, 'REFUND', '30.00', {
      roundId,
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    const refundB = createTransaction(wallet, 'REFUND', '30.00', {
      roundId,
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    const results = await Promise.all([submit(refundA), submit(refundB)]);

    expect(
      results.filter((result) => result.status === 'PROCESSED'),
    ).toHaveLength(1);

    expect(
      results.filter((result) => result.status === 'REJECTED'),
    ).toHaveLength(1);

    expect(results.every((result) => result.balance.amount === '100.00')).toBe(
      true,
    );

    const response = await fetch(`http://localhost:3000/wallets/${wallet.id}`);
  });

  it('should recover a refund when the original bet arrives later', async () => {
    const wallet = await createWallet('100.00');
    const roundId = randomUUID();
    const externalBetId = randomUUID();

    const refund = createTransaction(wallet, 'REFUND', '30.00', {
      roundId,
      referenceExternalTransactionId: externalBetId,
    });

    const pending = await submit(refund);

    expect(pending.status).toBe('PENDING_REFERENCE');
    expect(pending.balance.amount).toBe('100.00');

    // A BET original chega depois do REFUND.
    const bet = createTransaction(wallet, 'BET', '30.00', {
      roundId,
    });

    bet.externalTransactionId = externalBetId;

    const betResult = await submit(bet);

    expect(betResult.status).toBe('PROCESSED');
    expect(betResult.balance.amount).toBe('70.00');

    // Aguarda o worker recuperar a transação pendente.
    let recovered:
      | {
          status: string;
          balance: { amount: string };
        }
      | undefined;

    const deadline = Date.now() + 15000;

    while (Date.now() < deadline) {
      const response = await fetch(
        `${BASE_URL}/wagering/transactions/${pending.transactionId}`,
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      recovered = (await response.json()) as typeof recovered;

      if (recovered?.status !== 'PENDING_REFERENCE') {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    expect(recovered?.status).toBe('PROCESSED');
    expect(recovered?.balance.amount).toBe('100.00');
  }, 20000);
});

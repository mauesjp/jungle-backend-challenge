import { Decimal } from 'decimal.js';

export class Money {
  private readonly amount: Decimal;
  private readonly currency: string;

  constructor(amount: string, currency: string) {
    this.amount = new Decimal(amount);

    if (!this.amount.isFinite()) {
      //validaçao para garantir que o valor monetário seja finito
      throw new Error('Invalid monetary amount');
    }

    if (this.amount.decimalPlaces() > 2) {
      //validaçao para garantir que o valor monetário tenha no máximo duas casas decimais
      throw new Error('Monetary amount exceeds allowed precision');
    }

    this.currency = currency;
  }

  public add(other: Money): Money {
    //adiciona valor ao saldo

    if (other.currency !== this.currency) {
      throw new Error('currency does not match');
    }

    const money = this.amount.plus(other.amount).toString();
    const moneyReturn = new Money(money, this.currency);

    return moneyReturn;
  }

  public getAmount(): string {
    //retorna o valor atual de amount sem sofrer alteraçoes

    return this.amount.toFixed(2);
  }

  public subtract(other: Money): Money {
    //subtrai valor do saldo
    if (other.currency !== this.currency) {
      throw new Error('currency does not match');
    }
    const money = this.amount.minus(other.amount).toString();
    const moneyReturn = new Money(money, this.currency);

    return moneyReturn;
  }
}

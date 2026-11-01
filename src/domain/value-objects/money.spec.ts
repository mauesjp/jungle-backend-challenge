import { describe, expect, it } from 'vitest';
import { Money } from './money.js';

describe('Money', () => {
  it('should create a valid monetary value', () => {
    const money = new Money('100.50', 'BRL');

    expect(money).toBeInstanceOf(Money);
  });

  it('should reject amounts with excessive decimal places', () => {
    expect(() => new Money('100.123', 'BRL')).toThrow();
  });

  it('should reject NaN', () => {
    expect(() => new Money('NaN', 'BRL')).toThrow();
  });

  it('should reject Infinity', () => {
    expect(() => new Money('Infinity', 'BRL')).toThrow();
  });

  it('should add two monetary values', () => {
    const money = new Money('100.00', 'BRL');
    const money2 = new Money('50.00', 'BRL');

    const result = money.add(money2);

    expect(result.getAmount()).toBe('150.00');
  });

  it('should reject addition of different currencies', () => {
    const money = new Money('100.00', 'BRL');
    const money2 = new Money('50.00', 'USD');

    expect(() => money.add(money2)).toThrow();
  });

  it('should subtract two monetary values', () => {
    const money = new Money('100.00', 'BRL');
    const money2 = new Money('30.00', 'BRL');

    const result = money.subtract(money2);

    expect(result.getAmount()).toBe('70.00');
  });

  it('should reject subtraction of different currencies', () => {
    const money = new Money('100.00', 'BRL');
    const money2 = new Money('30.00', 'USD');

    expect(() => money.subtract(money2)).toThrow();
  });

  it('should not modify original monetary values', () => {
    const money = new Money('100.00', 'BRL');
    const money2 = new Money('30.00', 'BRL');

    const initialAmount = money.getAmount();
    const initialAmount2 = money2.getAmount();

    money.subtract(money2);

    expect(money.getAmount()).toBe(initialAmount);
    expect(money2.getAmount()).toBe(initialAmount2);
  });
});

import {describe, expect, it} from 'vitest';
import {Money} from './money.js';

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

        const money = new Money('100.00', 'BRL')
        const money2 = new Money('50.00', 'BRL')

        const result = money.add(money2)

        expect(result.getAmount()).toBe('150.00');
    });
});
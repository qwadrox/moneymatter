import { ACCOUNT_CATEGORIES } from '@bt/shared/types';
import { format } from 'date-fns';
import { describe, expect, it } from 'vitest';

import { computeRunwayMonths, computeRunwayWindow, isCashAccount, sumBalancesOnDate } from './helpers';

const day = ({ date }: { date: Date }) => format(date, 'yyyy-MM-dd');

describe('isCashAccount', () => {
  const base = { excludeFromStats: false };

  it('keeps credit cards, drops loans and vehicles', () => {
    expect(isCashAccount({ account: { ...base, accountCategory: ACCOUNT_CATEGORIES.creditCard } })).toBe(true);
    expect(isCashAccount({ account: { ...base, accountCategory: ACCOUNT_CATEGORIES.loan } })).toBe(false);
    expect(isCashAccount({ account: { ...base, accountCategory: ACCOUNT_CATEGORIES.vehicle } })).toBe(false);
  });

  it('drops stats-excluded accounts', () => {
    expect(
      isCashAccount({ account: { ...base, excludeFromStats: true, accountCategory: ACCOUNT_CATEGORIES.general } }),
    ).toBe(false);
  });
});

describe('computeRunwayWindow', () => {
  const now = new Date(2026, 9, 16);

  it('uses the last 6 full months when history is long enough', () => {
    const window = computeRunwayWindow({ now, earliestDate: new Date(2024, 0, 1) });
    expect(window && { from: day({ date: window.from }), to: day({ date: window.to }), months: window.months }).toEqual(
      {
        from: '2026-04-01',
        to: '2026-09-30',
        months: 6,
      },
    );
  });

  it('skips a partial first month of history', () => {
    const window = computeRunwayWindow({ now, earliestDate: new Date(2026, 6, 20) });
    expect(window && { from: day({ date: window.from }), months: window.months }).toEqual({
      from: '2026-08-01',
      months: 2,
    });
  });

  it('keeps a first month that starts on the 1st', () => {
    expect(computeRunwayWindow({ now, earliestDate: new Date(2026, 8, 1) })?.months).toBe(1);
  });

  it('returns null without a full month of history', () => {
    expect(computeRunwayWindow({ now, earliestDate: new Date(2026, 8, 15) })).toBeNull();
    expect(computeRunwayWindow({ now, earliestDate: new Date(2026, 9, 1) })).toBeNull();
    expect(computeRunwayWindow({ now, earliestDate: undefined })).toBeNull();
  });
});

describe('computeRunwayMonths', () => {
  it('divides cash by the average monthly spend', () => {
    expect(computeRunwayMonths({ totalCash: 12_000, totalExpenses: 24_000, months: 6 })).toBe(3);
    expect(computeRunwayMonths({ totalCash: 959, totalExpenses: 6_000, months: 6 })).toBe(1);
  });

  it('floors negative cash at zero months', () => {
    expect(computeRunwayMonths({ totalCash: -500, totalExpenses: 6_000, months: 6 })).toBe(0);
  });

  it('returns null with no spending', () => {
    expect(computeRunwayMonths({ totalCash: 1_000, totalExpenses: 0, months: 6 })).toBeNull();
  });
});

describe('sumBalancesOnDate', () => {
  const accounts = [
    { id: 'checking', creditLimit: 0, refCreditLimit: 0 },
    { id: 'card', creditLimit: 80, refCreditLimit: 2_000 },
  ];
  const rows = [
    { accountId: 'checking', amount: 1_000 },
    { accountId: 'card', amount: 2_500 },
    { accountId: 'loan', amount: -9_000 },
  ];

  it('sums only the given accounts', () => {
    expect(sumBalancesOnDate({ rows, accounts, includeCreditLimit: false })).toBe(3_500);
  });

  it('subtracts the credit limit when the setting is on', () => {
    expect(sumBalancesOnDate({ rows, accounts, includeCreditLimit: true })).toBe(1_500);
  });
});

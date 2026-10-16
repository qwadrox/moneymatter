import { ACCOUNT_CATEGORIES } from '@bt/shared/types';
import { describe, expect, it } from 'vitest';

import { computeAssetsLiabilities, formatShareLabel } from './helpers';

const point = {
  accountsBalance: 1_500,
  portfoliosBalance: 3_000,
  venturesBalance: 0,
  vehiclesBalance: 0,
  loansBalance: -2_000,
};

type Account = Parameters<typeof computeAssetsLiabilities>[0]['accounts'][number];

const account = ({ balance, ...rest }: { balance: number } & Partial<Account>): Account => ({
  excludeFromStats: false,
  accountCategory: ACCOUNT_CATEGORIES.general,
  currentBalance: balance,
  refCurrentBalance: balance,
  creditLimit: 0,
  refCreditLimit: 0,
  ...rest,
});

describe('computeAssetsLiabilities', () => {
  it('moves negative account balances from cash into credit without changing net worth', () => {
    const result = computeAssetsLiabilities({
      point,
      accounts: [account({ balance: 2_000 }), account({ balance: -500 })],
      includeCreditLimit: false,
    });

    expect(result.assets).toEqual([
      { key: 'investments', amount: 3_000 },
      { key: 'cash', amount: 2_000 },
    ]);
    expect(result.liabilities).toEqual([
      { key: 'loans', amount: 2_000 },
      { key: 'creditAndOverdrafts', amount: 500 },
    ]);
    expect(result.netWorth).toBe(2_500);
  });

  it('drops zero buckets and flips the loan sign', () => {
    const result = computeAssetsLiabilities({
      point: { ...point, portfoliosBalance: 0 },
      accounts: [account({ balance: 1_500 })],
      includeCreditLimit: false,
    });

    expect(result.assets).toEqual([{ key: 'cash', amount: 1_500 }]);
    expect(result.liabilities).toEqual([{ key: 'loans', amount: 2_000 }]);
    expect(result).toMatchObject({ assetsTotal: 1_500, liabilitiesTotal: 2_000, netWorth: -500 });
  });

  it('ignores shared-not-owned, stats-excluded, loan and vehicle accounts for credit debt', () => {
    const result = computeAssetsLiabilities({
      point,
      accounts: [
        account({ balance: -100, share: { isOwner: false } }),
        account({ balance: -200, excludeFromStats: true }),
        account({ balance: -300, accountCategory: ACCOUNT_CATEGORIES.loan }),
        account({ balance: -400, accountCategory: ACCOUNT_CATEGORIES.vehicle }),
        account({ balance: -50, share: { isOwner: true } }),
      ],
      includeCreditLimit: false,
    });

    expect(result.liabilities).toContainEqual({ key: 'creditAndOverdrafts', amount: 50 });
  });

  it('counts card debt net of the credit limit when the setting is on', () => {
    const card = account({
      balance: 800,
      accountCategory: ACCOUNT_CATEGORIES.creditCard,
      creditLimit: 1_000,
      refCreditLimit: 1_000,
    });

    const result = computeAssetsLiabilities({ point, accounts: [card], includeCreditLimit: true });

    expect(result.liabilities).toContainEqual({ key: 'creditAndOverdrafts', amount: 200 });
    expect(result.netWorth).toBe(
      point.accountsBalance +
        point.portfoliosBalance +
        point.venturesBalance +
        point.vehiclesBalance +
        point.loansBalance,
    );
  });
});

describe('formatShareLabel', () => {
  it('rounds and shows <1% for tiny non-zero shares', () => {
    expect(formatShareLabel({ part: 1, total: 3 })).toBe('33%');
    expect(formatShareLabel({ part: 1, total: 1_000 })).toBe('<1%');
    expect(formatShareLabel({ part: 0, total: 100 })).toBe('0%');
  });
});

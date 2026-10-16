import { describe, expect, it } from 'vitest';

import {
  comparisonCumulative,
  computeSpendingPace,
  formatPacePercent,
  parseCompareMode,
  splitDailyExpenses,
  toneOf,
} from './helpers';

const month = ({ length, perDay, firstDay = perDay }: { length: number; perDay: number; firstDay?: number }) =>
  Array.from({ length }, (_, i) => (i === 0 ? firstDay : perDay));

describe('computeSpendingPace', () => {
  it('follows the comparison shape so rent on day 1 does not inflate the forecast', () => {
    const rentMonth = month({ length: 30, perDay: 10, firstDay: 1_000 });
    const result = computeSpendingPace({
      currentMonth: month({ length: 15, perDay: 10, firstDay: 1_000 }),
      comparisonMonths: [rentMonth],
      daysInMonth: 30,
    });

    expect(result.spent).toBe(1_140);
    expect(result.comparison!.byToday).toBe(1_140);
    expect(result.comparison!.total).toBe(1_290);
    expect(result.comparison!.forecast).toBe(1_290);
    expect(result.comparison!.diffPercent).toBe(0);
    expect(result.comparison!.tone).toBe('neutral');
    expect(result.comparison!.forecastCumulative.slice(0, 14)).toEqual(Array(14).fill(null));
    expect(result.comparison!.forecastCumulative[14]).toBe(1_140);
  });

  it('repeats the last day of a shorter comparison month', () => {
    const result = computeSpendingPace({
      currentMonth: month({ length: 10, perDay: 20 }),
      comparisonMonths: [month({ length: 30, perDay: 10 })],
      daysInMonth: 31,
    });

    expect(result.comparison!.cumulative).toHaveLength(31);
    expect(result.comparison!.cumulative[29]).toBe(300);
    expect(result.comparison!.cumulative[30]).toBe(300);
    expect(result.comparison!.forecast).toBe(200 + 300 - 100);
    expect(result.comparison!.tone).toBe('over');
  });

  it('averages months of different lengths day by day', () => {
    expect(
      comparisonCumulative({
        months: [month({ length: 28, perDay: 10 }), month({ length: 31, perDay: 20 })],
        daysInMonth: 31,
      })!.slice(27),
    ).toEqual([(280 + 560) / 2, (280 + 580) / 2, (280 + 600) / 2, (280 + 620) / 2]);
  });

  it('leaves nothing to forecast on the last day', () => {
    const result = computeSpendingPace({
      currentMonth: month({ length: 31, perDay: 5 }),
      comparisonMonths: [month({ length: 31, perDay: 10 })],
      daysInMonth: 31,
    });

    expect(result.comparison!.forecast).toBe(result.spent);
    expect(result.comparison!.forecastCumulative.filter((value) => value !== null)).toEqual([155]);
    expect(result.comparison!.diffPercent).toBe(-50);
    expect(result.comparison!.tone).toBe('under');
  });

  it('returns no comparison without full months', () => {
    const result = computeSpendingPace({
      currentMonth: [5, 5],
      comparisonMonths: [],
      daysInMonth: 31,
    });

    expect(result).toEqual({ spentCumulative: [5, 10], spent: 10, comparison: null });
  });

  it('hides the percent when the comparison spent nothing', () => {
    const result = computeSpendingPace({
      currentMonth: [5],
      comparisonMonths: [month({ length: 30, perDay: 0 })],
      daysInMonth: 30,
    });

    expect(result.comparison!.diffPercent).toBeNull();
    expect(result.comparison!.tone).toBe('neutral');
  });
});

describe('splitDailyExpenses', () => {
  const now = new Date(2026, 9, 3);
  const day = ({ date, expenses, income = 0 }: { date: string; expenses: number; income?: number }) => ({
    periodStart: date,
    income,
    expenses,
  });

  it('drops leading months without cash flow and averages what exists', () => {
    const { currentMonth, fullMonths } = splitDailyExpenses({
      periods: [
        day({ date: '2026-07-15', expenses: 0 }),
        day({ date: '2026-08-31', expenses: 0, income: 100 }),
        day({ date: '2026-09-02', expenses: 40 }),
        day({ date: '2026-10-01', expenses: 7 }),
        day({ date: '2026-10-03', expenses: 3 }),
        day({ date: '2026-10-20', expenses: 99 }),
      ],
      now,
    });

    expect(currentMonth).toEqual([7, 0, 3]);
    expect(fullMonths).toHaveLength(2);
    expect(fullMonths[0]).toHaveLength(31);
    expect(fullMonths[1]).toHaveLength(30);
    expect(fullMonths[1]![1]).toBe(40);

    const pace = computeSpendingPace({ currentMonth, comparisonMonths: fullMonths, daysInMonth: 31 });
    expect(pace.comparison!.monthsCount).toBe(2);
    expect(pace.comparison!.total).toBe(20);
  });

  it('returns no full months when history starts this month', () => {
    const { fullMonths } = splitDailyExpenses({
      periods: [day({ date: '2026-10-01', expenses: 7 })],
      now,
    });

    expect(fullMonths).toEqual([]);
  });
});

describe('formatPacePercent', () => {
  it('signs positives and rounds', () => {
    expect(formatPacePercent({ percent: 12.4 })).toBe('+12%');
    expect(formatPacePercent({ percent: -7.6 })).toBe('-8%');
    expect(formatPacePercent({ percent: -0.2 })).toBe('0%');
  });
});

describe('toneOf', () => {
  it.each([
    { diffPercent: 5, tone: 'neutral' },
    { diffPercent: -5, tone: 'neutral' },
    { diffPercent: 5.01, tone: 'over' },
    { diffPercent: -5.01, tone: 'under' },
  ])('$diffPercent% → $tone', ({ diffPercent, tone }) => {
    expect(toneOf({ diffPercent })).toBe(tone);
  });
});

describe('parseCompareMode', () => {
  it('keeps known modes and falls back to avg', () => {
    expect(parseCompareMode({ value: 'last' })).toBe('last');
    expect(parseCompareMode({ value: 'avg' })).toBe('avg');
    expect(parseCompareMode({ value: undefined })).toBe('avg');
    expect(parseCompareMode({ value: 'weekly' })).toBe('avg');
  });
});

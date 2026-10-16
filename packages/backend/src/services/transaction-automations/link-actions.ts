import {
  ACCOUNT_CATEGORIES,
  AUTOMATION_LINK_ACTION_TYPES,
  type AutomationAction,
  type RecordId,
  TRANSACTION_TRANSFER_NATURE,
  TRANSACTION_TYPES,
} from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import Accounts from '@models/accounts.model';
import { findTransactions, updateTransactions } from '@models/transactions-query';
import * as Transactions from '@models/transactions.model';
import { isLinkableRow } from '@services/bank-data-providers/utils/auto-link-transfers';
import { linkLoanPayments } from '@services/loans/link-loan-payments.service';
import { linkTransactions } from '@services/transactions/transactions-linking/link-transactions';
import { addDays, subDays } from 'date-fns';
import { DatabaseError, Op } from 'sequelize';

export type AutomationLinkAction = Extract<AutomationAction, { type: (typeof AUTOMATION_LINK_ACTION_TYPES)[number] }>;

export const isLinkAction = (action: AutomationAction): action is AutomationLinkAction =>
  (AUTOMATION_LINK_ACTION_TYPES as readonly string[]).includes(action.type);

/** Stamped on every row a rule linked. The post-sync pass never re-links a stamped row, so a manual unlink sticks. */
export interface AutomationLinkStamp {
  ruleId: RecordId;
  linkedAt: string;
}

export const AUTOMATION_LINK_STAMP_KEY = 'automationLink';

export const hasAutomationLinkStamp = ({ tx }: { tx: Pick<Transactions.default, 'externalData'> }) =>
  Boolean(tx.externalData?.[AUTOMATION_LINK_STAMP_KEY]);

/**
 * Bank value dates trail card payments by days (Erste books a card top-up 1–6 days after it
 * happened), so a value-date comparison has to fetch candidates over a wider stored-date range.
 */
const VALUE_DATE_SLACK_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const oppositeType = ({ type }: { type: TRANSACTION_TYPES }) =>
  type === TRANSACTION_TYPES.expense ? TRANSACTION_TYPES.income : TRANSACTION_TYPES.expense;

/** UTC day number of the row's comparison date. A missing or malformed value date falls back to the stored date. */
export const comparisonDay = ({
  tx,
  dateBasis,
}: {
  tx: Pick<Transactions.default, 'time' | 'externalData'>;
  dateBasis: Extract<AutomationLinkAction, { type: 'link_transfer' }>['dateBasis'];
}): number => {
  const valueDate = dateBasis === 'value' ? tx.externalData?.valueDate : undefined;
  const parsed = typeof valueDate === 'string' ? Date.parse(`${valueDate.slice(0, 10)}T00:00:00Z`) : NaN;
  const time = Number.isNaN(parsed) ? new Date(tx.time).getTime() : parsed;
  return Math.floor(time / MS_PER_DAY);
};

const bankReference = ({ tx }: { tx: Pick<Transactions.default, 'externalData'> }): string | null => {
  const reference = tx.externalData?.referenceNumber;
  return typeof reference === 'string' && reference.trim().length > 0 ? reference.trim() : null;
};

/**
 * The other leg for `link_transfer`: the closest row by comparison date on the target account.
 * Two rows equally close leave the pair ambiguous, so nothing is picked.
 */
export const findTransferCounterpart = async ({
  tx,
  action,
  userId,
}: {
  tx: Transactions.default;
  action: Extract<AutomationLinkAction, { type: 'link_transfer' }>;
  userId: number;
}): Promise<Transactions.default | null> => {
  if (tx.accountId === action.accountId) return null;

  const reference = action.matchBy === 'reference' ? bankReference({ tx }) : null;
  if (action.matchBy === 'reference' && !reference) return null;

  const seedDay = comparisonDay({ tx, dateBasis: action.dateBasis });
  const slack = action.maxDaysApart + (action.dateBasis === 'value' ? VALUE_DATE_SLACK_DAYS : 0);
  const seedDate = new Date(seedDay * MS_PER_DAY);

  const candidates = await findTransactions({
    planned: 'exclude',
    access: { creator: userId },
    transfers: 'exclude',
    balanceAdjustments: 'exclude',
    completeness: 'all',
    where: {
      accountId: action.accountId,
      transactionType: oppositeType({ type: tx.transactionType }),
      refundLinked: false,
      ...(action.matchBy === 'amount' ? { currencyCode: tx.currencyCode, amount: tx.amount.toCents() } : {}),
      time: { [Op.between]: [subDays(seedDate, slack + 1), addDays(seedDate, slack + 1)] },
    },
  });

  const scored = candidates
    .filter((candidate) => isLinkableRow({ tx: candidate }) && !hasAutomationLinkStamp({ tx: candidate }))
    .filter((candidate) => action.matchBy === 'amount' || bankReference({ tx: candidate }) === reference)
    .map((candidate) => ({
      candidate,
      distance: Math.abs(comparisonDay({ tx: candidate, dateBasis: action.dateBasis }) - seedDay),
    }))
    .filter(({ distance }) => distance <= action.maxDaysApart)
    .toSorted((a, b) => a.distance - b.distance);

  const [best, runnerUp] = scored;
  if (!best) return null;
  if (runnerUp && runnerUp.distance === best.distance) return null;

  return best.candidate;
};

const stampRows = async ({ ids, ruleId, userId }: { ids: RecordId[]; ruleId: RecordId; userId: number }) => {
  const stamp: AutomationLinkStamp = { ruleId, linkedAt: new Date().toISOString() };
  const rows = await findTransactions({
    planned: 'exclude',
    access: { creator: userId },
    balanceAdjustments: 'exclude',
    completeness: 'all',
    attributes: ['id', 'externalData'],
    where: { id: ids },
  });

  for (const row of rows) {
    await updateTransactions({
      planned: 'exclude',
      access: { creator: userId },
      balanceAdjustments: 'exclude',
      where: { id: row.id },
      values: { externalData: { ...row.externalData, [AUTOMATION_LINK_STAMP_KEY]: stamp } },
    });
  }
};

/**
 * A validation failure (overpaying loan, split leg, row already claimed) skips the row. A
 * database error has aborted the surrounding transaction, so it must propagate.
 */
const skipOnValidationError = async <T>({ run, context }: { run: () => Promise<T>; context: string }) => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DatabaseError) throw error;
    logger.warn(`Automation link skipped (${context}): ${error instanceof Error ? error.message : error}`);
    return null;
  }
};

/**
 * Runs one link action against a row. Resolves to the ids it linked (both legs of a transfer,
 * the payment row of a loan link), or `null` when nothing was linked.
 */
export const applyLinkAction = async ({
  transactionId,
  action,
  userId,
  ruleId,
}: {
  transactionId: RecordId;
  action: AutomationLinkAction;
  userId: number;
  ruleId: RecordId;
}): Promise<RecordId[] | null> => {
  // The caller's instance may predate an earlier link in the same run.
  const tx = await Transactions.default.findByPk(transactionId);
  if (!tx || tx.transferNature !== TRANSACTION_TRANSFER_NATURE.not_transfer || tx.refundLinked || tx.isPlanned) {
    return null;
  }
  if (!isLinkableRow({ tx })) return null;

  if (action.type === 'link_transfer') {
    const counterpart = await findTransferCounterpart({ tx, action, userId });
    if (!counterpart) return null;

    const [baseId, oppositeId] =
      tx.transactionType === TRANSACTION_TYPES.expense ? [tx.id, counterpart.id] : [counterpart.id, tx.id];

    const linked = await skipOnValidationError({
      run: () => linkTransactions({ userId, ids: [[baseId, oppositeId]] }),
      context: `rule ${ruleId}, transfer [${baseId}, ${oppositeId}]`,
    });
    if (!linked) return null;

    await stampRows({ ids: [baseId, oppositeId], ruleId, userId });
    return [baseId, oppositeId];
  }

  if (tx.transactionType !== TRANSACTION_TYPES.expense) return null;

  const loanAccount = await Accounts.findOne({
    where: { id: action.loanAccountId, userId },
    attributes: ['id', 'accountCategory'],
  });
  if (!loanAccount || loanAccount.accountCategory !== ACCOUNT_CATEGORIES.loan) return null;

  const linked = await skipOnValidationError({
    run: () => linkLoanPayments({ userId, accountId: action.loanAccountId, transactionIds: [tx.id] }),
    context: `rule ${ruleId}, loan payment ${tx.id}`,
  });
  if (!linked) return null;

  await stampRows({ ids: [tx.id], ruleId, userId });
  return [tx.id];
};

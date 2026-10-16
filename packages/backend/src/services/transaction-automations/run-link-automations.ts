import { type RecordId, TRANSACTION_TRANSFER_NATURE } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import { connection } from '@models/connection';
import TransactionAutomations from '@models/transaction-automations.model';
import { findTransactions } from '@models/transactions-query';
import { withTransaction } from '@services/common/with-transaction';
import { subDays } from 'date-fns';
import { DatabaseError, Op, QueryTypes } from 'sequelize';

import { applyLinkAction, hasAutomationLinkStamp, isLinkAction } from './link-actions';
import { scanAutomationMatches } from './preview';
import { findMissingAutomationRef } from './references';

/**
 * How far back the pass re-checks unlinked rows. The other leg often lands in a later sync
 * (Revolut books a top-up at once, Erste days later), so the row a rule targets may have
 * been imported before its partner existed.
 */
const LOOKBACK_DAYS = 21;

/** Upper bound on re-checked rows per sync; the newest win. */
const LOOKBACK_ROW_LIMIT = 500;

const findRecentUnlinkedIds = async ({ userId }: { userId: number }): Promise<RecordId[]> => {
  const rows = await findTransactions({
    planned: 'exclude',
    access: { creator: userId },
    transfers: { natures: [TRANSACTION_TRANSFER_NATURE.not_transfer] },
    balanceAdjustments: 'exclude',
    completeness: { cap: { limit: LOOKBACK_ROW_LIMIT, onTruncated: 'log', context: { userId } } },
    attributes: ['id', 'externalData'],
    order: [
      ['time', 'DESC'],
      ['id', 'DESC'],
    ],
    where: { time: { [Op.gte]: subDays(new Date(), LOOKBACK_DAYS) }, refundLinked: false },
  });

  return rows.filter((row) => !hasAutomationLinkStamp({ tx: row })).map((row) => row.id);
};

const runLinkAutomationsInTransaction = withTransaction(
  async ({ userId, transactionIds }: { userId: number; transactionIds: RecordId[] }): Promise<Set<RecordId>> => {
    const linked = new Set<RecordId>();

    const rules = (
      await TransactionAutomations.findAll({
        where: { userId, isEnabled: true },
        order: [
          ['position', 'ASC'],
          ['id', 'ASC'],
        ],
      })
    ).filter((rule) => rule.actions.some(isLinkAction));
    if (!rules.length) return linked;

    try {
      // Same lock as the heuristic transfer matcher: concurrent syncs of one user must not
      // claim overlapping legs.
      await connection.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:scope), :userId)', {
        replacements: { scope: 'auto-link-transfers', userId },
        type: QueryTypes.SELECT,
      });

      const candidateIds = [...new Set([...transactionIds, ...(await findRecentUnlinkedIds({ userId }))])];
      if (!candidateIds.length) return linked;

      for (const rule of rules) {
        if (await findMissingAutomationRef({ userId, conditions: rule.conditions, actions: rule.actions })) continue;

        const { rows } = await scanAutomationMatches({
          userId,
          conditions: rule.conditions,
          transactionIds: candidateIds.filter((id) => !linked.has(id)),
        });

        let matchCount = 0;

        // Oldest first, so a run of equal fixed amounts pairs in booking order.
        for (const row of rows.toReversed()) {
          if (linked.has(row.id) || hasAutomationLinkStamp({ tx: row })) continue;

          for (const action of rule.actions.filter(isLinkAction)) {
            const ids = await applyLinkAction({ transactionId: row.id, action, userId, ruleId: rule.id });
            if (!ids) continue;
            ids.forEach((id) => linked.add(id));
            matchCount++;
            break;
          }
        }

        if (matchCount > 0) {
          await connection.sequelize.query(
            'UPDATE "TransactionAutomations" SET "matchCount" = "matchCount" + :matchCount, "lastMatchedAt" = now() WHERE id = :id',
            { replacements: { id: rule.id, matchCount } },
          );
          logger.info(`Automation ${rule.id} linked ${matchCount} transaction(s) for user ${userId}`);
        }
      }

      return linked;
    } catch (error) {
      if (error instanceof DatabaseError) throw error;
      logger.error({ message: 'Link automations failed', error: error as Error });
      return linked;
    }
  },
);

/**
 * Post-sync pass for the rules' link actions (`link_transfer`, `link_loan_payment`). Runs
 * before the heuristic transfer matcher, so a user's rule decides ambiguous fixed-amount
 * pairs. Besides the freshly synced rows it re-checks the last weeks' unlinked rows, whose
 * partner may only have arrived now. Returns every linked id; callers keep them out of the
 * sync event like auto-linked legs.
 */
export async function runLinkAutomationsAfterSync({
  userId,
  transactionIds,
}: {
  userId: number;
  /** Plain strings, like the provider sync hands them to `autoLinkTransfers`. */
  transactionIds: string[];
}): Promise<Set<string>> {
  return runLinkAutomationsInTransaction({ userId, transactionIds: transactionIds as RecordId[] });
}

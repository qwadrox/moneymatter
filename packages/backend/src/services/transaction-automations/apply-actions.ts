import {
  AUTOMATION_PROTECTED_CATEGORY_SOURCES,
  type AutomationNoteMode,
  CATEGORIZATION_SOURCE,
} from '@bt/shared/types';
import TransactionAutomations from '@models/transaction-automations.model';
import TransactionTags from '@models/transaction-tags.model';
import * as Transactions from '@models/transactions.model';
import { DOMAIN_EVENTS, eventBus } from '@services/common/event-bus';

import { applyLinkAction, isLinkAction } from './link-actions';

const MAX_NOTE_LENGTH = 2000;

export const buildNote = ({
  current,
  mode,
  value,
}: {
  current: string;
  mode: AutomationNoteMode;
  value: string;
}): string => {
  if (mode === 'replace') return value.trim().slice(0, MAX_NOTE_LENGTH);
  const merged = mode === 'append' ? `${current} ${value}` : `${value} ${current}`;
  return merged.trim().slice(0, MAX_NOTE_LENGTH);
};

/**
 * Runs a matched rule's actions against the re-fetched row; resolves to whether any
 * action was applied. Every write is conflict-free by construction: ids are pre-checked
 * against the owner and junction rows are inserted with `ignoreDuplicates`.
 */
export const applyActions = async ({
  transaction,
  rule,
  userId,
  skipSetCategory,
  categorizedAt = new Date().toISOString(),
  includeLinkActions = false,
}: {
  transaction: Transactions.default;
  rule: TransactionAutomations;
  userId: number;
  skipSetCategory: boolean;
  /** Shared stamp so every row of one bulk run carries the same `categorizedAt`. */
  categorizedAt?: string;
  /**
   * Link actions need the other leg, which a row being created rarely has yet; the post-sync
   * pass (`run-link-automations.ts`) runs them instead. Applying to history runs them here.
   */
  includeLinkActions?: boolean;
}): Promise<boolean> => {
  let applied = false;

  // Link actions go last: they turn the row into a transfer leg.
  const actions = [...rule.actions.filter((action) => !isLinkAction(action)), ...rule.actions.filter(isLinkAction)];

  for (const action of actions) {
    switch (action.type) {
      case 'set_category': {
        const source = transaction.categorizationMeta?.source;
        if (skipSetCategory || (source && AUTOMATION_PROTECTED_CATEGORY_SOURCES.includes(source))) {
          continue;
        }

        await Transactions.updateTransactionById({
          id: transaction.id,
          userId,
          categoryId: action.categoryId,
          categorizationMeta: {
            source: CATEGORIZATION_SOURCE.userRule,
            ruleId: rule.id,
            categorizedAt,
          },
        });
        break;
      }
      case 'add_tags': {
        await TransactionTags.bulkCreate(
          action.tagIds.map((tagId) => ({ tagId, transactionId: transaction.id })),
          { ignoreDuplicates: true },
        );

        // Junction-only writes leave the row's timestamp untouched, so clients can't
        // detect the change. Sequelize skips a bulk update whose only value is
        // `updatedAt`, hence the instance save.
        transaction.changed('updatedAt', true);
        await transaction.save();

        eventBus.emit(DOMAIN_EVENTS.TRANSACTIONS_TAGGED, { tagIds: action.tagIds, userId });
        break;
      }
      case 'set_payee':
        await Transactions.updateTransactionById({
          id: transaction.id,
          userId,
          payeeId: action.payeeId,
          payeeLocked: true,
        });
        break;
      case 'set_note':
        await Transactions.updateTransactionById({
          id: transaction.id,
          userId,
          note: buildNote({ current: transaction.note ?? '', mode: action.mode, value: action.value }),
        });
        break;
      case 'link_transfer':
      case 'link_loan_payment': {
        if (!includeLinkActions) continue;
        const linkedIds = await applyLinkAction({ transactionId: transaction.id, action, userId, ruleId: rule.id });
        if (!linkedIds) continue;
        break;
      }
      default:
        action satisfies never;
    }
    applied = true;
  }

  return applied;
};

import { runLinkAutomationsAfterSync } from '@services/transaction-automations/run-link-automations';

import { autoLinkTransfers } from './auto-link-transfers';
import { emitTransactionsSyncEvent } from './emit-transactions-sync-event';

export async function linkAndEmitSyncedTransactions({
  userId,
  accountId,
  transactionIds,
  extraAutoLinkCandidateIds,
}: {
  userId: number;
  accountId: string;
  transactionIds: string[];
  extraAutoLinkCandidateIds?: string[];
}): Promise<void> {
  const candidateIds = [...transactionIds, ...(extraAutoLinkCandidateIds ?? [])];
  const ruleLinkedIds = await runLinkAutomationsAfterSync({ userId, transactionIds: candidateIds });

  const autoLinkedIds = await autoLinkTransfers({
    userId,
    transactionIds: candidateIds.filter((id) => !ruleLinkedIds.has(id)),
  });

  emitTransactionsSyncEvent({
    userId,
    accountId,
    transactionIds: transactionIds.filter((id) => !autoLinkedIds.has(id) && !ruleLinkedIds.has(id)),
  });
}

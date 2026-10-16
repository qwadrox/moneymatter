import type { AutomationAction, AutomationConditions, RecordId } from '@bt/shared/types';
import { BANK_PROVIDER_TYPE, TRANSACTION_TRANSFER_NATURE, TRANSACTION_TYPES } from '@bt/shared/types';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as helpers from '@tests/helpers';
import { useSelfHost } from '@tests/helpers/self-host';
import {
  FixedTransaction,
  MOCK_IDENTIFICATION_HASH_1,
  MOCK_IDENTIFICATION_HASH_2,
} from '@tests/mocks/enablebanking/data';
import { format, subDays } from 'date-fns';

// `link_transfer` / `link_loan_payment` automation actions, driven through mocked Enable
// Banking syncs. HASH_1 plays the debit account (Erste), HASH_2 the receiving one (Revolut).

useSelfHost();

const day = (daysAgo: number) => format(subDays(new Date(), daysAgo), 'yyyy-MM-dd');

describe('Automation link actions (E2E)', () => {
  beforeEach(() => {
    helpers.enablebanking.resetSessionCounter();
  });

  afterEach(() => {
    helpers.enablebanking.resetTransactionConfig();
  });

  async function setupTwoAccounts(): Promise<{
    connectionId: string;
    mainAccountId: RecordId;
    topUpAccountId: RecordId;
  }> {
    helpers.enablebanking.setFixedTransactions([]);

    const connectResult = await helpers.bankDataProviders.connectProvider({
      providerType: BANK_PROVIDER_TYPE.ENABLE_BANKING,
      credentials: helpers.enablebanking.mockCredentials(),
      raw: true,
    });
    const state = await helpers.enablebanking.getConnectionState(connectResult.connectionId);
    await helpers.makeRequest({
      method: 'post',
      url: '/bank-data-providers/enablebanking/oauth-callback',
      payload: { connectionId: connectResult.connectionId, code: helpers.enablebanking.mockAuthCode, state },
    });
    const { syncedAccounts } = await helpers.bankDataProviders.connectSelectedAccounts({
      connectionId: connectResult.connectionId,
      accountExternalIds: [MOCK_IDENTIFICATION_HASH_1, MOCK_IDENTIFICATION_HASH_2],
      raw: true,
    });

    const main = syncedAccounts.find((a) => a.externalId === MOCK_IDENTIFICATION_HASH_1);
    const topUp = syncedAccounts.find((a) => a.externalId === MOCK_IDENTIFICATION_HASH_2);
    if (!main || !topUp) throw new Error('Expected both mock accounts to be connected');

    return { connectionId: connectResult.connectionId, mainAccountId: main.id, topUpAccountId: topUp.id };
  }

  async function syncAccountWith({
    connectionId,
    accountId,
    transactions,
  }: {
    connectionId: string;
    accountId: RecordId;
    transactions: FixedTransaction[];
  }) {
    helpers.enablebanking.setFixedTransactions(transactions);
    await helpers.bankDataProviders.syncTransactionsForAccount({ connectionId, accountId, raw: true });
  }

  const listTransactions = ({ accountId }: { accountId: RecordId }) =>
    helpers.getTransactions({ accountIds: [accountId], raw: true });

  /** Erste-style card top-up: booked days after the card date, which only the value date keeps. */
  const cardTopUp = ({
    cardDay,
    bookedDay,
    ref,
  }: {
    cardDay: string;
    bookedDay: string;
    ref: string;
  }): FixedTransaction => ({
    amount: '100.00',
    currency: 'EUR',
    isExpense: true,
    bookingDate: bookedDay,
    transactionDate: bookedDay,
    valueDate: cardDay,
    entryReference: ref,
    counterpartyIban: null,
    remittanceInformation: ['Revolut Dublin card purchase'],
  });

  /** Revolut-style top-up income, booked on the card date. */
  const topUpIncome = ({ onDay, ref }: { onDay: string; ref: string }): FixedTransaction => ({
    amount: '100.00',
    currency: 'EUR',
    isExpense: false,
    bookingDate: onDay,
    transactionDate: onDay,
    valueDate: onDay,
    entryReference: ref,
    counterpartyIban: null,
    remittanceInformation: ['Top-Up by *8082'],
  });

  const topUpRule = ({ mainAccountId, topUpAccountId }: { mainAccountId: RecordId; topUpAccountId: RecordId }) =>
    helpers.createAutomation({
      payload: {
        name: 'Erste to Revolut top-ups',
        conditions: {
          match: 'all',
          items: [
            { field: 'account', operator: 'in', value: [mainAccountId] },
            { field: 'transactionType', operator: 'equals', value: TRANSACTION_TYPES.expense },
            { field: 'note', operator: 'contains_any', value: ['Revolut'] },
          ],
        },
        actions: [
          { type: 'link_transfer', accountId: topUpAccountId, matchBy: 'amount', dateBasis: 'value', maxDaysApart: 0 },
        ],
      },
      raw: true,
    });

  /**
   * Two equal top-ups a few days apart, each booked by the debit bank days later: by booking
   * date both incomes fit both expenses, by value date each expense has exactly one partner.
   */
  const ambiguousTopUps = () => ({
    expenses: [
      cardTopUp({ cardDay: day(12), bookedDay: day(8), ref: 'erste_a' }),
      cardTopUp({ cardDay: day(6), bookedDay: day(5), ref: 'erste_b' }),
    ],
    incomes: [topUpIncome({ onDay: day(12), ref: 'rev_a' }), topUpIncome({ onDay: day(6), ref: 'rev_b' })],
  });

  const CARD_DAY_BY_BOOKED_DAY: Record<string, string> = { [day(8)]: day(12), [day(5)]: day(6) };

  const expectPairedByValueDate = async ({
    mainAccountId,
    topUpAccountId,
  }: {
    mainAccountId: RecordId;
    topUpAccountId: RecordId;
  }) => {
    const mainTxs = await listTransactions({ accountId: mainAccountId });
    const topUpTxs = await listTransactions({ accountId: topUpAccountId });
    expect(mainTxs).toHaveLength(2);
    expect(topUpTxs).toHaveLength(2);

    for (const expense of mainTxs) {
      expect(expense.transferNature).toBe(TRANSACTION_TRANSFER_NATURE.common_transfer);
      const partner = topUpTxs.find((tx) => tx.transferId === expense.transferId)!;
      expect(partner).toBeDefined();
      // The list API omits externalData, so check against the value dates `ambiguousTopUps` set.
      const cardDay = CARD_DAY_BY_BOOKED_DAY[format(new Date(expense.time), 'yyyy-MM-dd')];
      expect(format(new Date(partner.time), 'yyyy-MM-dd')).toBe(cardDay);
    }
  };

  describe('link_transfer by value date', () => {
    it('pairs fixed-amount card top-ups by value date when the receiving leg synced first', async () => {
      const { connectionId, mainAccountId, topUpAccountId } = await setupTwoAccounts();
      await topUpRule({ mainAccountId, topUpAccountId });
      const { expenses, incomes } = ambiguousTopUps();

      await syncAccountWith({ connectionId, accountId: topUpAccountId, transactions: incomes });
      await syncAccountWith({ connectionId, accountId: mainAccountId, transactions: expenses });

      await expectPairedByValueDate({ mainAccountId, topUpAccountId });
    });

    it('links an earlier synced row once its partner arrives in a later sync', async () => {
      const { connectionId, mainAccountId, topUpAccountId } = await setupTwoAccounts();
      await topUpRule({ mainAccountId, topUpAccountId });
      const { expenses, incomes } = ambiguousTopUps();

      await syncAccountWith({ connectionId, accountId: mainAccountId, transactions: expenses });
      const beforePartner = await listTransactions({ accountId: mainAccountId });
      expect(beforePartner.every((tx) => tx.transferNature === TRANSACTION_TRANSFER_NATURE.not_transfer)).toBe(true);

      await syncAccountWith({ connectionId, accountId: topUpAccountId, transactions: incomes });

      await expectPairedByValueDate({ mainAccountId, topUpAccountId });
    });

    it('leaves the rows alone without a rule (the heuristic matcher sees an ambiguous pair)', async () => {
      const { connectionId, mainAccountId, topUpAccountId } = await setupTwoAccounts();
      const { expenses, incomes } = ambiguousTopUps();

      await syncAccountWith({ connectionId, accountId: topUpAccountId, transactions: incomes });
      await syncAccountWith({ connectionId, accountId: mainAccountId, transactions: expenses });

      const mainTxs = await listTransactions({ accountId: mainAccountId });
      expect(mainTxs.every((tx) => tx.transferNature === TRANSACTION_TRANSFER_NATURE.not_transfer)).toBe(true);
    });

    it('does not re-link a pair the user unlinked', async () => {
      const { connectionId, mainAccountId, topUpAccountId } = await setupTwoAccounts();
      await topUpRule({ mainAccountId, topUpAccountId });

      await syncAccountWith({
        connectionId,
        accountId: topUpAccountId,
        transactions: [topUpIncome({ onDay: day(4), ref: 'rev_single' })],
      });
      await syncAccountWith({
        connectionId,
        accountId: mainAccountId,
        transactions: [cardTopUp({ cardDay: day(4), bookedDay: day(2), ref: 'erste_single' })],
      });

      const [linked] = await listTransactions({ accountId: mainAccountId });
      expect(linked!.transferNature).toBe(TRANSACTION_TRANSFER_NATURE.common_transfer);

      await helpers.unlinkTransferTransactions({ transferIds: [linked!.transferId!], raw: true });

      // Any later sync re-runs the pass over recent rows.
      await syncAccountWith({ connectionId, accountId: topUpAccountId, transactions: [] });

      const [afterSync] = await listTransactions({ accountId: mainAccountId });
      expect(afterSync!.transferNature).toBe(TRANSACTION_TRANSFER_NATURE.not_transfer);
    });

    it('skips a pair when two partners sit at the same distance', async () => {
      const { connectionId, mainAccountId, topUpAccountId } = await setupTwoAccounts();
      await helpers.createAutomation({
        payload: {
          name: 'Loose window',
          conditions: { match: 'all', items: [{ field: 'account', operator: 'in', value: [mainAccountId] }] },
          actions: [
            {
              type: 'link_transfer',
              accountId: topUpAccountId,
              matchBy: 'amount',
              dateBasis: 'value',
              maxDaysApart: 3,
            },
          ],
        },
        raw: true,
      });

      await syncAccountWith({
        connectionId,
        accountId: topUpAccountId,
        transactions: [topUpIncome({ onDay: day(7), ref: 'rev_x' }), topUpIncome({ onDay: day(5), ref: 'rev_y' })],
      });
      await syncAccountWith({
        connectionId,
        accountId: mainAccountId,
        transactions: [cardTopUp({ cardDay: day(6), bookedDay: day(6), ref: 'erste_mid' })],
      });

      const [expense] = await listTransactions({ accountId: mainAccountId });
      expect(expense!.transferNature).toBe(TRANSACTION_TRANSFER_NATURE.not_transfer);
    });
  });

  describe('link_transfer by bank reference', () => {
    it('links the two legs of a currency conversion and leaves the fee as an expense', async () => {
      const { connectionId, mainAccountId, topUpAccountId } = await setupTwoAccounts();
      await helpers.createAutomation({
        payload: {
          name: 'Wise conversions',
          conditions: {
            match: 'all',
            items: [
              { field: 'account', operator: 'in', value: [mainAccountId] },
              { field: 'note', operator: 'starts_with_any', value: ['Converted'] },
            ],
          },
          actions: [
            {
              type: 'link_transfer',
              accountId: topUpAccountId,
              matchBy: 'reference',
              dateBasis: 'transaction',
              maxDaysApart: 1,
            },
          ],
        },
        raw: true,
      });

      // Principal and received amounts differ (different currencies in production); only the reference ties them.
      await syncAccountWith({
        connectionId,
        accountId: topUpAccountId,
        transactions: [
          {
            amount: '6543.21',
            currency: 'EUR',
            isExpense: false,
            bookingDate: day(3),
            transactionDate: day(3),
            entryReference: 'wise_in',
            referenceNumber: 'BALANCE-123456',
            counterpartyIban: null,
            remittanceInformation: ['BALANCE-123456', 'Converted 11,922.50 TRY to 78,056 HUF'],
          },
        ],
      });
      await syncAccountWith({
        connectionId,
        accountId: mainAccountId,
        transactions: [
          {
            amount: '11922.50',
            currency: 'EUR',
            isExpense: true,
            bookingDate: day(3),
            transactionDate: day(3),
            entryReference: 'wise_out',
            referenceNumber: 'BALANCE-123456',
            counterpartyIban: null,
            remittanceInformation: ['Converted 11,922.50 TRY to 78,056 HUF (fee: 77.50 TRY)'],
          },
          {
            amount: '77.50',
            currency: 'EUR',
            isExpense: true,
            bookingDate: day(3),
            transactionDate: day(3),
            entryReference: 'wise_fee',
            referenceNumber: 'FEE-BALANCE-123456',
            counterpartyIban: null,
            remittanceInformation: ['Wise Charges for: BALANCE-123456'],
          },
        ],
      });

      const mainTxs = await listTransactions({ accountId: mainAccountId });
      const [received] = await listTransactions({ accountId: topUpAccountId });
      const principal = mainTxs.find((tx) => tx.note?.startsWith('Converted'))!;
      const fee = mainTxs.find((tx) => tx.note?.startsWith('Wise Charges'))!;

      expect(principal.transferNature).toBe(TRANSACTION_TRANSFER_NATURE.common_transfer);
      expect(principal.transferId).toBe(received!.transferId);
      expect(fee.transferNature).toBe(TRANSACTION_TRANSFER_NATURE.not_transfer);
    });
  });

  describe('link_loan_payment', () => {
    it('links a fixed loan installment to the loan account after a sync', async () => {
      const { connectionId, mainAccountId } = await setupTwoAccounts();
      const loan = await helpers.createLoan({
        payload: helpers.buildCreateLoanPayload({ name: 'Honda loan', currencyCode: 'EUR', initialBalance: 5_000 }),
        raw: true,
      });

      await helpers.createAutomation({
        payload: {
          name: 'Cetelem installment',
          conditions: {
            match: 'all',
            items: [
              { field: 'note', operator: 'contains_any', value: ['CETELEM'] },
              { field: 'amount', operator: 'equals', value: { min: 720.72 }, currency: { mode: 'transaction' } },
            ],
          },
          actions: [{ type: 'link_loan_payment', loanAccountId: loan.id as RecordId }],
        },
        raw: true,
      });

      await syncAccountWith({
        connectionId,
        accountId: mainAccountId,
        transactions: [
          {
            amount: '720.72',
            currency: 'EUR',
            isExpense: true,
            bookingDate: day(2),
            transactionDate: day(2),
            entryReference: 'cetelem_installment',
            counterpartyIban: null,
            remittanceInformation: ['CETELEM BANK installment'],
          },
          {
            amount: '720.72',
            currency: 'EUR',
            isExpense: true,
            bookingDate: day(2),
            transactionDate: day(2),
            entryReference: 'unrelated_same_amount',
            counterpartyIban: null,
            remittanceInformation: ['Furniture shop'],
          },
        ],
      });

      const mainTxs = await listTransactions({ accountId: mainAccountId });
      const installment = mainTxs.find((tx) => tx.note?.includes('CETELEM'))!;
      const unrelated = mainTxs.find((tx) => tx.note?.includes('Furniture'))!;

      expect(installment.transferNature).toBe(TRANSACTION_TRANSFER_NATURE.transfer_to_loan);
      expect(unrelated.transferNature).toBe(TRANSACTION_TRANSFER_NATURE.not_transfer);

      const loanTxs = await listTransactions({ accountId: loan.id as RecordId });
      expect(loanTxs).toHaveLength(1);
      expect(loanTxs[0]!.transferId).toBe(installment.transferId);
    });
  });

  describe('apply to history', () => {
    it('links rows synced before the rule existed', async () => {
      const { connectionId, mainAccountId, topUpAccountId } = await setupTwoAccounts();
      const { expenses, incomes } = ambiguousTopUps();

      await syncAccountWith({ connectionId, accountId: topUpAccountId, transactions: incomes });
      await syncAccountWith({ connectionId, accountId: mainAccountId, transactions: expenses });

      const rule = await topUpRule({ mainAccountId, topUpAccountId });
      const preview = await helpers.previewAutomation({ payload: { automationId: rule.id, limit: 50 }, raw: true });
      expect(preview.matchedCount).toBe(2);

      const result = await helpers.applyAutomationToHistory({
        id: rule.id,
        payload: { transactionIds: preview.matches.map((tx) => tx.id) },
        raw: true,
      });
      expect(result.appliedCount).toBe(2);

      await expectPairedByValueDate({ mainAccountId, topUpAccountId });
    });

    it('lists a pending row for a non-link rule but not for a link rule', async () => {
      await helpers.patchUserSettings({ patch: { importPendingBankTransactions: true }, raw: true });
      const { connectionId, mainAccountId, topUpAccountId } = await setupTwoAccounts();

      await syncAccountWith({
        connectionId,
        accountId: topUpAccountId,
        transactions: [topUpIncome({ onDay: day(2), ref: 'rev_pending' })],
      });
      // A pending card payment has no value date yet.
      await syncAccountWith({
        connectionId,
        accountId: mainAccountId,
        transactions: [
          {
            ...cardTopUp({ cardDay: day(2), bookedDay: day(2), ref: 'erste_pending' }),
            valueDate: undefined,
            status: 'PDNG',
          },
        ],
      });

      const [pending] = await listTransactions({ accountId: mainAccountId });
      expect(pending!.transferNature).toBe(TRANSACTION_TRANSFER_NATURE.not_transfer);

      const linkRule = await topUpRule({ mainAccountId, topUpAccountId });
      const noteActions: AutomationAction[] = [{ type: 'set_note', mode: 'append', value: '#topup' }];
      const noteRule = await helpers.createAutomation({
        payload: { name: 'Tag top-ups', conditions: linkRule.conditions, actions: noteActions },
        raw: true,
      });

      const preview = (payload: Parameters<typeof helpers.previewAutomation>[0]['payload']) =>
        helpers.previewAutomation({ payload: { ...payload, limit: 50 }, raw: true });

      // Apply-to-history review dialog.
      const linkReview = await preview({ automationId: linkRule.id });
      expect(linkReview.matches).toHaveLength(0);
      expect(linkReview.settledCount).toBe(1);
      expect((await preview({ automationId: noteRule.id })).matches.map((tx) => tx.id)).toEqual([pending!.id]);

      // Editor preview of a draft.
      expect((await preview({ conditions: linkRule.conditions, actions: linkRule.actions })).matches).toHaveLength(0);
      expect((await preview({ conditions: linkRule.conditions, actions: noteActions })).matches).toHaveLength(1);
      expect((await preview({ conditions: linkRule.conditions })).matches).toHaveLength(1);
      expect(
        (await preview({ conditions: linkRule.conditions, actions: [...noteActions, ...linkRule.actions] })).matches,
      ).toHaveLength(1);
    });

    it('does not list a row the user unlinked from a rule', async () => {
      const { connectionId, mainAccountId, topUpAccountId } = await setupTwoAccounts();
      const rule = await topUpRule({ mainAccountId, topUpAccountId });

      await syncAccountWith({
        connectionId,
        accountId: topUpAccountId,
        transactions: [topUpIncome({ onDay: day(4), ref: 'rev_unlinked' })],
      });
      await syncAccountWith({
        connectionId,
        accountId: mainAccountId,
        transactions: [cardTopUp({ cardDay: day(4), bookedDay: day(2), ref: 'erste_unlinked' })],
      });

      const [linked] = await listTransactions({ accountId: mainAccountId });
      await helpers.unlinkTransferTransactions({ transferIds: [linked!.transferId!], raw: true });

      const review = await helpers.previewAutomation({ payload: { automationId: rule.id, limit: 50 }, raw: true });
      expect(review.matches).toHaveLength(0);
      expect(review.settledCount).toBe(1);
    });
  });

  describe('validation', () => {
    const conditions: AutomationConditions = {
      match: 'all',
      items: [{ field: 'note', operator: 'contains_any', value: ['Revolut'] }],
    };

    it('rejects a date window above the limit', async () => {
      const { topUpAccountId } = await setupTwoAccounts();
      const response = await helpers.createAutomation({
        payload: {
          name: 'Too wide',
          conditions,
          actions: [
            {
              type: 'link_transfer',
              accountId: topUpAccountId,
              matchBy: 'amount',
              dateBasis: 'value',
              maxDaysApart: 11,
            },
          ],
        },
      });
      expect(response.statusCode).toBe(422);
    });

    it('rejects a rule with two link actions', async () => {
      const { topUpAccountId } = await setupTwoAccounts();
      const actions: AutomationAction[] = [
        { type: 'link_transfer', accountId: topUpAccountId, matchBy: 'amount', dateBasis: 'value', maxDaysApart: 0 },
        { type: 'link_loan_payment', loanAccountId: topUpAccountId },
      ];
      const response = await helpers.createAutomation({ payload: { name: 'Both', conditions, actions } });
      expect(response.statusCode).toBe(422);
    });

    it('rejects an account that does not belong to the user', async () => {
      await setupTwoAccounts();
      const response = await helpers.createAutomation({
        payload: {
          name: 'Foreign account',
          conditions,
          actions: [
            {
              type: 'link_transfer',
              accountId: '00000000-0000-4000-8000-000000000000' as RecordId,
              matchBy: 'amount',
              dateBasis: 'value',
              maxDaysApart: 0,
            },
          ],
        },
      });
      expect(response.statusCode).toBe(422);
    });
  });
});

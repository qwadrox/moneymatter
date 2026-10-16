# MoneyMatter fork

This is a personal fork of [letehaha/moneymatter](https://github.com/letehaha/moneymatter). It tracks upstream
releases and adds a few features on top. Every addition extends an existing MoneyMatter concept; nothing is
replaced or redefined, and upstream data stays compatible both ways.

Branch `fork` = the latest upstream release tag + the commits listed below.

## Added features

### Automations: "Link as transfer" action (`link_transfer`)

A rule action that links a matched transaction to its other leg on a chosen account. The result is a normal
MoneyMatter transfer (`common_transfer`), the same one you get by linking by hand.

- **Match by amount.** The other leg has the same currency and amount, on the opposite side. Use this for fixed
  top-ups between your own accounts.
- **Match by bank reference.** The other leg has the same bank reference number, in any currency or amount. Use
  this for currency conversions that a bank books as two rows. Wise is an example: the principal and the
  received amount share `BALANCE-<id>`, and the fee row stays a normal expense.
- **Date basis.** Compares either the transaction date or the bank's value date. Value dates help when one bank
  books a card payment days late; Erste is an example.
- **Days apart.** The allowed date gap, from 0 to 10 days. If the nearest candidate is tied with another at the
  same distance, the pair is ambiguous and nothing is linked.

### Automations: "Link as loan payment" action (`link_loan_payment`)

A rule action that records a matched expense as a payment to a loan account, using the existing loan payment
linking (`transfer_to_loan`). Use it for fixed installments, e.g. note contains "CETELEM" and amount equals
72,072 HUF.

### How link actions run

- They run after every bank sync, before MoneyMatter's built-in transfer auto-matcher, so your rule decides
  ambiguous pairs. A row a rule links is kept out of AI categorization, just like auto-linked transfers.
- Each run also re-checks unlinked rows from the last 21 days, because the other leg often arrives in a later
  sync.
- Rows a rule linked are stamped (`externalData.automationLink`). If you unlink one by hand, it stays unlinked.
- "Apply to history" and preview support the new actions. A rule can hold at most one link action.
- The live create hook skips link actions. Every other action type behaves exactly as upstream.

### Container images on GHCR

[`.github/workflows/fork-images.yml`](.github/workflows/fork-images.yml) builds `linux/amd64` images from the
upstream Dockerfiles when a `v*-mm.*` tag is pushed:

- `ghcr.io/qwadrox/moneymatter-be:<tag>` and `:sha-<short>`
- `ghcr.io/qwadrox/moneymatter-fe:<tag>` and `:sha-<short>`

They are drop-in replacements for the upstream `budget-tracker-be` / `budget-tracker-fe` images: same runtime
configuration, same volumes.

## Footprint in upstream files

New files hold most of the code:

- `packages/backend/src/services/transaction-automations/link-actions.ts`
- `packages/backend/src/services/transaction-automations/run-link-automations.ts`
- `packages/backend/src/services/transaction-automations/link-actions.e2e.ts`
- `.github/workflows/fork-images.yml`
- `FORK.md`

Small edits in upstream files:

| File                                                                                  | Change                                               |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `packages/shared/src/types/transaction-automations.ts`                                | Two action types and their constants                 |
| `packages/backend/.../transaction-automations/zod-schemas.ts`                         | Schemas for the two actions; at most one link action |
| `packages/backend/.../transaction-automations/apply-actions.ts`                       | Link actions run last and only when asked            |
| `packages/backend/.../transaction-automations/apply-to-history.ts`                    | Oldest first; link actions enabled                   |
| `packages/backend/.../transaction-automations/preview.ts`, `references.ts`            | Settled check; account references                    |
| `packages/backend/.../bank-data-providers/utils/link-and-emit-synced-transactions.ts` | Calls the post-sync pass before the auto-matcher     |
| `packages/backend/.../mcp/tools/transaction-automation-inputs.ts`                     | Documents the actions for the MCP tool               |
| `packages/frontend/src/pages/automations/**`                                          | Editor UI, validation, chips                         |
| `packages/frontend/src/i18n/locales/chunks/en/pages/automations.json`                 | English strings (other locales fall back to English) |

## Syncing with upstream

```sh
git fetch upstream --tags
git switch fork
git rebase <new-upstream-tag>      # e.g. v0.32.0
# resolve conflicts, then run the checks:
npm run lint && npm run typecheck && npm run format:check
cd packages/backend && npm run test:e2e -- '--testPathPattern=transaction-automations|transfer-auto-link|loan-payment-linking'
git push --force-with-lease origin fork
git tag v0.32.0-mm.1 && git push origin v0.32.0-mm.1   # builds the images
```

Fork tags follow `<upstream tag>-mm.<n>`.

## License

AGPL-3.0, same as upstream. See [LICENSE](LICENSE).

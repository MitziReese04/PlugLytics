# PlugLytics Ledger and Accounting System for Tuition Reconciliation

> **Status: documented, not decided, not built.** This covers README item 7: the ledger and accounting system used for tuition reconciliation. The pilot school's accounting system is not known yet, so PlugLytics plans a **system-neutral journal export** first and a direct integration only after the school's system is known. Values marked **TODO** need the school's finance office or the group.

## Contents

- [Decision summary](#decision-summary)
- [Who owns the books](#who-owns-the-books)
- [Accounting system options](#accounting-system-options)
- [Journal entries PlugLytics would export](#journal-entries-pluglytics-would-export)
- [Journal export file](#journal-export-file)
- [Daily reconciliation](#daily-reconciliation)
- [What must change in the code first](#what-must-change-in-the-code-first)
- [Questions for the school's finance office](#questions-for-the-schools-finance-office)

## Decision summary

| Item | Decision |
| --- | --- |
| Book of record | The **school's** accounting system. PlugLytics is never the official ledger |
| Pilot integration | A daily journal-entry CSV that the school's accountant imports or posts |
| Direct API integration | Later, only for the system the pilot school actually uses (TODO) |
| Reporting currency | TODO: PHP for a Philippine school |
| Chart of accounts | The school's own account codes, mapped in a settings table (TODO) |
| Stellar (XLM, USDC) accounting treatment | TODO: the school's accountant must decide; PlugLytics only reports the facts |

## Who owns the books

- The school's finance office keeps the general ledger and closes each period.
- PlugLytics keeps the **operational records**: invoices, scholarships, discounts, fees, payments, Stellar payment requests and refunds. It shows analytics and sends the finance office a matched, explainable export.
- Every exported line can be traced back to a PlugLytics record, and for Stellar payments to the transaction hash on the public ledger (see [settlement.md](../stellar/settlement.md)).

## Accounting system options

The pilot school will most likely already use one of these. Ask before building anything.

| Option | When it fits | Pilot integration | Later integration |
| --- | --- | --- | --- |
| The school's existing ERP or school-management system | Most schools already have one for billing and the registrar | CSV journal import | Its API, if it has one (TODO) |
| QuickBooks Online | Small schools and training providers | CSV journal import | Accounting API (TODO: confirm) |
| Xero | Small schools and training providers | CSV journal import | Accounting API (TODO: confirm) |
| Odoo (Accounting app) | Schools that want open-source or self-hosted software | CSV journal import | Odoo's external API (TODO: confirm) |
| Spreadsheet ledger | Very small providers | Same CSV, opened in a spreadsheet | None |

A CSV journal works with all of them. It also keeps PlugLytics from needing write access to the school's books during the pilot.

## Journal entries PlugLytics would export

Proposed double-entry mapping. Account names are placeholders; the school maps each one to its own account code (TODO).

| Event in PlugLytics | Debit | Credit | Amount |
| --- | --- | --- | --- |
| Invoice issued | Tuition receivable | Tuition revenue | `amount` (gross) |
| Scholarship on the invoice | Scholarships and discounts (contra-revenue or expense, TODO) | Tuition receivable | `scholarship_amount` |
| Discount on the invoice | Scholarships and discounts | Tuition receivable | `amount × discount_percent ÷ 100` |
| Fees on the invoice | Tuition receivable | Fee income (or a liability if collected for someone else, TODO) | `platform_fee + transaction_fee` |
| Cash, card or bank payment | Cash or bank (per method) | Tuition receivable | `payments.amount` |
| Stellar payment completed | Digital asset or clearing account (XLM / USDC, TODO) | Tuition receivable | Invoice-currency value at the locked quote |
| Refund issued | Tuition receivable (or a refunds account, TODO) | Cash, bank, or digital asset | `refunds.amount` |

Not exported to the student ledger:

- `instructor_cost` is a cost allocation for margin reports, not something billed to the student.
- Network fees, exchange-rate differences on XLM, and anchor fees need the accountant's treatment (TODO). PlugLytics reports them separately so they are not hidden in tuition.

## Journal export file

Proposed `journal-YYYY-MM-DD.csv`, one line per debit or credit:

```csv
entryId,entryDate,account,debit,credit,currency,invoiceId,studentNumber,sourceType,sourceId,reference,memo
JE-2026-000123,2026-11-21,Tuition receivable,25000.00,,PHP,1042,2026-00123,invoice,1042,,Tuition 1st term
JE-2026-000123,2026-11-21,Tuition revenue,,25000.00,PHP,1042,2026-00123,invoice,1042,,Tuition 1st term
JE-2026-000124,2026-11-21,Stellar clearing (USDC),12500.00,,PHP,1042,2026-00123,payment_request,pr_8f2c,<transactionHash>,Stellar memo PLG-1042
JE-2026-000124,2026-11-21,Tuition receivable,,12500.00,PHP,1042,2026-00123,payment_request,pr_8f2c,<transactionHash>,Stellar memo PLG-1042
```

Rules:

- Each `entryId` balances: total debits = total credits.
- `sourceType` + `sourceId` point to the PlugLytics record, so every line can be traced.
- Use the student number, not the student's name.
- The example values are made up.

## Daily reconciliation

1. **PlugLytics side:** match payments to invoices. Stellar payments are matched by memo and checked on the ledger, as in [settlement.md](../stellar/settlement.md).
2. **Export:** generate the day's journal CSV and a summary: totals by account and currency, plus unmatched items.
3. **School side:** the accountant imports or posts the journal and compares it with:
   - the bank statement, for cash, card and bank payments;
   - the Stellar account history, for XLM and USDC;
   - the school's own receivable balance per student.
4. **Differences:** anything that does not match goes on an exceptions list with an owner and a due date. Nothing is edited in place; corrections are new entries.
5. **Period close:** at month end and term end, PlugLytics totals (net billed, collected, refunds, outstanding) must equal the school's ledger. TODO: who signs off.

## What must change in the code first

These come from [definitions.md](./definitions.md#issues-found-in-the-current-formulas):

- [ ] Count completed Stellar payments as collected. Today only the `payments` table counts.
- [ ] Subtract refunds from collected and handle them in outstanding balances.
- [ ] Total money per currency, or convert to the reporting currency.
- [ ] Add a journal-export endpoint and CSV (admin only), for example `GET /api/v1/admin/finance/journal?from=&to=&format=csv` (TODO).
- [ ] Add a settings table that maps PlugLytics account names to the school's account codes.

## Questions for the school's finance office

- [ ] Which accounting system and version do you use for tuition?
- [ ] Can it import journal entries from CSV? In which format?
- [ ] What are the account codes for tuition receivable, tuition revenue, scholarships, discounts, fees, cash, bank and refunds?
- [ ] Are scholarships recorded as a revenue reduction or as an expense?
- [ ] What is your reporting currency, and how should XLM / USDC receipts be recorded?
- [ ] Who receives the daily file, and who approves differences and the period close?
- [ ] How long must PlugLytics keep financial records, given the school's own retention rules?

# PlugLytics Pilot Budget and Grant Plan

> **Status: draft with placeholders.** Everything marked **TODO** must be replaced with real values before this plan is shared. Amounts are shown as `0` and dates as `TODO-YYYY-MM-DD` until then.
>
> **Source of truth:** [pilot-budget-and-grant.json](./pilot-budget-and-grant.json). Edit the numbers and dates there first, then update the tables below to match. Run `npm test` afterwards: it checks that the budget adds up to the funding and that the shares add up to 100%.

## Contents

- [Grant](#grant)
- [Pilot budget by category](#pilot-budget-by-category)
- [Milestones](#milestones)
- [Reporting dates](#reporting-dates)
- [How to fill in the TODOs](#how-to-fill-in-the-todos)

## Grant

| Item | Value |
| --- | --- |
| Program | Stellar Instaward |
| Grant amount | **0 USD** (TODO: replace with the awarded amount) |
| Currency | USD (TODO: confirm) |
| Award date | TODO-YYYY-MM-DD |
| Grant start date | TODO-YYYY-MM-DD |
| Grant end date | TODO-YYYY-MM-DD |
| Other funding | **0 USD** (TODO: co-funding, if any; leave 0 if none) |

- **Total pilot budget** = grant amount + other funding = **0 USD** (TODO).
- Confirm the amount, currency, dates and any spending rules with the grant administrator.

## Pilot budget by category

The categories come from [PROPOSAL.md](../../PROPOSAL.md#budget-categories). The suggested shares are a starting point (TODO: confirm).

| Category | Suggested share | Amount (USD) |
| --- | --- | --- |
| API and data integration engineering | 25% | **0** (TODO) |
| Payment reconciliation and data modeling | 20% | **0** (TODO) |
| Privacy and security review | 15% | **0** (TODO) |
| Frontend/dashboard implementation | 15% | **0** (TODO) |
| Test fixtures and automated tests | 10% | **0** (TODO) |
| Pilot onboarding and documentation | 10% | **0** (TODO) |
| Accessibility and deployment support | 5% | **0** (TODO) |
| **Total** | **100%** | **0** (TODO) |

Rules:

- The category amounts must add up to the **total pilot budget** (grant + other funding).
- The suggested shares must add up to 100%.
- A simple way to fill in amounts: amount = total pilot budget × suggested share ÷ 100, then adjust.

## Milestones

Based on the roadmap in [PROPOSAL.md](../../PROPOSAL.md#proposed-roadmap).

| ID | Milestone | Deliverable | Target date | Budget share | Status |
| --- | --- | --- | --- | --- | --- |
| M1 | Grant-aligned repository, demo, and documentation | Public repository with seeded demo, dashboard, VS Code plugin, and Stellar Payments docs in `docs/stellar/` | TODO-YYYY-MM-DD (already done) | 0% | `complete` |
| M2 | Stellar Payments sandbox and payment-adapter specification | Testnet merchant credentials configured; payment-request and Horizon-matching spec signed off | TODO-YYYY-MM-DD (~30 days after start) | 15% | `in_progress` |
| M3 | Secure invoice reconciliation and webhooks | Daily reconciliation, signed webhooks with per-customer secrets, refund procedure in sandbox | TODO-YYYY-MM-DD (~60 days after start) | 25% | `not_started` |
| M4 | Pilot payment and aging dashboards | Dashboards for payment status, collection rate, aging, refunds and settlement reports | TODO-YYYY-MM-DD (~90 days after start) | 20% | `not_started` |
| M5 | Pilot with one school or training provider | One institution onboarded; pilot payments processed and reconciled; staff feedback collected | TODO-YYYY-MM-DD (~120 days after start) | 25% | `not_started` |
| M6 | Security, accessibility, and deployment hardening | Security and privacy review, accessibility audit, production deployment with backups and monitoring | TODO-YYYY-MM-DD (~180 days after start) | 15% | `not_started` |

- **Budget share** is the part of the total pilot budget planned for each milestone (TODO: confirm). The shares add up to 100%. M1 is 0% because it was finished before the grant.
- **Status** is one of `not_started`, `in_progress`, `complete` or `delayed`.
- M2 is marked `in_progress` because the sandbox credential configuration and the Stellar docs already exist on the `StellarPay` branch.

## Reporting dates

| ID | Report | Due date | Milestones | What it covers |
| --- | --- | --- | --- | --- |
| R1 | Kickoff report | TODO-YYYY-MM-DD (~2 weeks after start) | M1, M2 | Confirmed scope, team and timeline; final budget by category; sandbox setup progress; risks |
| R2 | Progress report 1 | TODO-YYYY-MM-DD (~60 days after start) | M2, M3 | M2 result and M3 progress; spend vs budget by category; test coverage of payment and authorization endpoints; issues and plan changes |
| R3 | Progress report 2 | TODO-YYYY-MM-DD (~120 days after start) | M4, M5 | M4 result and pilot status; spend vs budget by category; early pilot metrics (collection-rate accuracy, time to reconcile a term, staff task time); pilot feedback |
| R4 | Final report | TODO-YYYY-MM-DD (within 30 days after grant end) | M5, M6 | Results for every milestone; final spend vs budget; all evaluation metrics from PROPOSAL.md; security, privacy and accessibility review outcomes; lessons learned and next steps |

Every report should include:

- milestone statuses (from the table above)
- spend to date vs budget, by category
- what changed since the last report, and why
- risks and blockers

TODO: confirm the required report dates and format with the grant administrator. The dates above are suggestions.

## How to fill in the TODOs

1. In [pilot-budget-and-grant.json](./pilot-budget-and-grant.json):
   - Set `grant.amount` and, if any, `otherFunding.amount`.
   - Set each category's `amount`. They must add up to the grant plus other funding.
   - Replace every `TODO-YYYY-MM-DD` with a real date (`YYYY-MM-DD`).
   - Adjust `suggestedSharePercent` and `budgetSharePercent` if needed. Each set must still add up to 100.
   - Update milestone `status` as work moves on.
2. Run `npm test`. The grant data test fails if the numbers no longer add up, a date is not valid, or a status is unknown.
3. Copy the same values into the tables in this file.
4. Search both files for `TODO` to check nothing was missed.

# PlugLytics Enrollment, Retention, and Financial Definitions

> **Status: documented, not built.** This covers README item 6: the real enrollment, retention, and financial definitions. It lists what the code calculates today, the definition proposed for the pilot, and who at the school must confirm it. **The code has not been changed yet.** The proposed definitions need the pilot school's registrar and finance office to agree first (see [pilot-institution.md](./pilot-institution.md#contacts)).

## Contents

- [Why this matters](#why-this-matters)
- [Issues found in the current formulas](#issues-found-in-the-current-formulas)
- [Enrollment definitions](#enrollment-definitions)
- [Retention and completion definitions](#retention-and-completion-definitions)
- [Academic definitions](#academic-definitions)
- [Financial definitions](#financial-definitions)
- [Next steps](#next-steps)

## Why this matters

Registrars, finance offices, and the Commission on Higher Education each count "enrolled" and "retained" in their own way. If PlugLytics uses different rules from the school's official reports, the dashboard and the school's reports will disagree and staff will stop trusting the numbers. Every definition below must therefore match the pilot school's own reporting rules.

## Issues found in the current formulas

These were found by reading `src/routes/admin.js` and running the queries on the seeded demo database.

| # | Metric | Problem today | Effect on the demo data | Proposed fix |
| --- | --- | --- | --- | --- |
| 1 | Retention rate | Counts only `active` enrollments as retained. When a term ends, everyone who finished becomes `completed` and counts as **not** retained | Shows **0%** for Fall 2023, Spring 2024 and Fall 2024, and 90% for Spring 2025. The proposed formula gives **94.7%** for every term | Count `active` + `completed` as retained, and leave `waitlisted` out of the total |
| 2 | Retention, dropout, enrolled students | `waitlisted` students are counted as enrolled | Inflates the denominators: 125 of 2,500 demo enrollments are waitlisted | Leave `waitlisted` out of every enrollment count |
| 3 | Seat utilization | Counts every status except `dropped`, so `waitlisted` and `withdrawn` students fill seats | Overstates how full sections are | Count only `active` and `completed` |
| 4 | Collected and collection rate | Only the `payments` table counts. Completed Stellar payments (`payment_requests`) are never added to it, and refunds are not subtracted | Once Stellar or refunds are used, collected amounts are wrong | Collected = payments + completed Stellar payments − refunds |
| 5 | Outstanding balance and aging | Refunds are not added back. Invoices not yet due land in the `0-30` overdue bucket | Not-yet-due balances look overdue | Add a `not yet due` bucket and handle refunds |
| 6 | All money totals | Amounts in different currencies (`USD`, `PHP`) are added together | Demo invoices are all `USD`, so no effect yet | Total per currency, or convert to the school's reporting currency (TODO) |
| 7 | Pass rate | Passing is a final grade of at least 60 | Philippine schools often use 75% passing, or a 1.00–5.00 scale with 3.00 passing | Make the passing mark a setting, confirmed by the school |

## Enrollment definitions

Enrollment statuses in `src/schema.sql`: `active`, `completed`, `dropped`, `withdrawn`, `waitlisted`.

| Term | Current code | Proposed pilot definition | Confirm with |
| --- | --- | --- | --- |
| Enrollment | One row in `enrollments`: one student in one section | Same | Registrar |
| Counted enrollment | Any status | Status `active`, `completed`, `dropped` or `withdrawn`. **Not** `waitlisted` | Registrar |
| Enrolled students (headcount) | Distinct students with any enrollment in the filter | Distinct students with at least one counted enrollment **on the census date** | Registrar |
| Census date | Not used | The official date the school freezes enrollment counts for the term, for example the end of the adding/dropping period. TODO: per term | Registrar |
| Waitlisted | Status `waitlisted` | Same; reported separately, never in enrollment totals | Registrar |
| Dropped | Status `dropped` | Left the section **before** the census date (no grade, usually no record) | Registrar |
| Withdrawn | Status `withdrawn` | Left the section **after** the census date (often a "W" on the record) | Registrar |
| Year level | `students.year_level` | Same, taken from the registrar, not inferred | Registrar |

## Retention and completion definitions

| Term | Current code | Proposed pilot definition | Confirm with |
| --- | --- | --- | --- |
| In-term retention rate | `active` ÷ all enrollments × 100 | (`active` + `completed`) ÷ counted enrollments × 100 | Registrar |
| Dropout rate | (`dropped` + `withdrawn`) ÷ all enrollments × 100 | (`dropped` + `withdrawn`) ÷ counted enrollments × 100, so retention + dropout = 100% | Registrar |
| Completion rate | Not calculated | `completed` ÷ counted enrollments × 100, for terms that have ended | Registrar |
| Term-to-term persistence | Not calculated | Students counted in term *T* who are also counted in term *T+1*, or who graduated in term *T*, ÷ students counted in term *T* × 100 | Registrar |
| Year-to-year retention | Not calculated | Same as persistence, comparing the first term of one school year with the first term of the next. This is the number most schools and regulators mean by "retention". TODO: confirm the school's official formula | Registrar, quality assurance office |

Proposed SQL for in-term retention (for reference only, not applied yet):

```sql
ROUND(SUM(CASE WHEN e.status IN ('active','completed') THEN 1 ELSE 0 END) * 100.0 /
  NULLIF(SUM(CASE WHEN e.status <> 'waitlisted' THEN 1 ELSE 0 END), 0), 1) AS retentionPercent
```

## Academic definitions

| Term | Current code | Proposed pilot definition | Confirm with |
| --- | --- | --- | --- |
| Pass rate | Final grade ≥ 60 ÷ graded enrollments × 100 | Final grade ≥ the school's passing mark ÷ graded enrollments × 100. TODO: passing mark and grading scale (percent or 1.00–5.00) | Registrar, program head |
| Course progress | Submitted or late items ÷ assigned items × 100 | Same. Only items already due count as assigned | Program head |
| Submission rate | Submitted or late ÷ enrolled students × 100 | Same, using counted enrollments only | Program head |
| At-risk student | 2+ missing submissions and/or attendance below 75% | Same thresholds, but make both settings. If the school has no attendance data in Canvas, use missing submissions only (see [lms-integration.md](./lms-integration.md#gaps-data-canvas-does-not-have)) | Program head, guidance office |
| Minimum cohort | 5 students | Same. Required for privacy | DPO |

## Financial definitions

Invoice fields come from `src/schema.sql`. See also [payments-api.md](../stellar/payments-api.md#pricing-fields) and [settlement.md](../stellar/settlement.md).

| Term | Current code | Proposed pilot definition | Confirm with |
| --- | --- | --- | --- |
| Gross billed | Sum of invoice `amount` | Same: tuition and assessed fees before scholarships or discounts | Finance |
| Scholarships | Sum of `scholarship_amount` | Same. Scholarships reduce the price; they are never payments | Finance |
| Discounts | `amount × discount_percent ÷ 100` | Same | Finance |
| Fees | `platform_fee + transaction_fee` | Same. TODO: confirm whether the school or the student pays each fee | Finance |
| Net billed | `final_amount` = gross − scholarships − discounts + fees | Same | Finance |
| Collected | Sum of `payments.amount` | Sum of `payments.amount` + completed Stellar payments (in the invoice currency) − issued refunds | Finance |
| Collection rate | Collected ÷ net billed × 100 | Same formula, using the new "collected", and only for invoices already due (TODO: confirm) | Finance |
| Outstanding balance | `final_amount` − payments, per invoice | `final_amount` − collected for that invoice, never below 0 (overpayments are reported separately as credits) | Finance |
| Aging buckets | Days since due date: `0-30`, `31-60`, `60+` | `not yet due`, `1-30`, `31-60`, `61-90`, `90+` days past due. TODO: confirm the school's buckets | Finance |
| Refunds | Sum of `refunds.amount` | Same, by refund date, linked to the original payment (see [refunds-and-chargebacks.md](../stellar/refunds-and-chargebacks.md)) | Finance |
| Reporting currency | None: currencies are added together | TODO: PHP for a Philippine school. Each total is in one currency | Finance |
| Instructor cost | `instructor_cost` on invoices | TODO: confirm whether this is a per-invoice allocation or should come from payroll | Finance |

## Next steps

1. Review this file with the pilot school's registrar and finance office, and fill in every TODO.
2. Fix issues 1–3 (enrollment and retention) in `src/routes/admin.js`, with tests based on the demo numbers above.
3. Fix issues 4–6 (money) after the accounting decisions in [accounting-and-ledger.md](./accounting-and-ledger.md).
4. Make the passing mark, at-risk thresholds and aging buckets configurable (issue 7).
5. Update the [Metric formulas](../../README.md#metric-formulas) table in the README to match.

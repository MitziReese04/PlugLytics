# PlugLytics Pilot Institution

> **Status: template, not decided.** This covers README item 5: the pilot institution's name, program, and authorized contact. No school has agreed to a pilot yet, so every value is **TODO**. Fill this file in when a school signs on. Do not put anyone's name or contact details here without their permission.

## Contents

- [Pilot institution](#pilot-institution)
- [Pilot scope](#pilot-scope)
- [Contacts](#contacts)
- [Approvals before any real data](#approvals-before-any-real-data)
- [What makes a good pilot school](#what-makes-a-good-pilot-school)
- [How to approach a school](#how-to-approach-a-school)

## Pilot institution

| Item | Value |
| --- | --- |
| Institution name | TODO |
| Type | TODO: college, university, senior high school, or training provider |
| Campus / location | TODO |
| LMS | Canvas (see [lms-integration.md](./lms-integration.md)); TODO: confirm |
| Accounting system | TODO (see [accounting-and-ledger.md](./accounting-and-ledger.md)) |
| Agreement status | TODO: not contacted / in discussion / agreement signed |
| Agreement date | TODO-YYYY-MM-DD |

## Pilot scope

Keep the first pilot small: one program, one term.

| Item | Value |
| --- | --- |
| Program(s) | TODO, for example one BS program |
| Specialization(s) | TODO |
| Term | TODO, for example the next full term after the agreement |
| Number of sections | TODO (target: 5 to 15) |
| Estimated students | TODO (target: 100 to 400, enough for the five-student minimum cohort rule) |
| Estimated instructors | TODO |
| Roles taking part | Students, instructors, program admin, finance staff (TODO: confirm) |
| Payments in scope | TODO: analytics only, or also Stellar testnet payments |
| Start and end dates | TODO-YYYY-MM-DD to TODO-YYYY-MM-DD; must line up with milestone M5 in [pilot-budget-and-grant.md](../stellar/pilot-budget-and-grant.md#milestones) |

## Contacts

Fill in one person per role. A person can hold more than one role.

| Role | Why PlugLytics needs them | Name | Position | Email |
| --- | --- | --- | --- | --- |
| **Authorized contact / signatory** | Signs the pilot agreement and speaks for the school | TODO | TODO | TODO |
| Data Protection Officer (DPO) | Approves the data-sharing agreement and privacy impact assessment | TODO | TODO | TODO |
| Program head / faculty champion | Picks the sections, recruits instructors, gives feedback | TODO | TODO | TODO |
| Registrar | Enrollment status, withdrawals, section capacity, program and year level | TODO | TODO | TODO |
| Canvas administrator | Creates the API and LTI developer keys | TODO | TODO | TODO |
| Finance / accounting contact | Invoices, payments, refunds, scholarships, reconciliation | TODO | TODO | TODO |
| IT security contact | Reviews hosting, access and backups | TODO | TODO | TODO |

PlugLytics side:

| Role | Name |
| --- | --- |
| Pilot lead and main contact for the school | TODO |
| Technical lead (deployment, Canvas import) | TODO |
| Data and privacy lead | TODO |

## Approvals before any real data

No real student data is imported until every box is ticked:

- [ ] Signed pilot agreement (memorandum of agreement) naming the scope above
- [ ] Data-sharing agreement approved by the school's DPO, following the Data Privacy Act of 2012 (RA 10173) and National Privacy Commission guidance on data sharing
- [ ] Privacy impact assessment for the pilot
- [ ] Privacy notice to students and instructors explaining what is collected and why
- [ ] Ethics or research approval, if the school treats the pilot as research (TODO: ask the school)
- [ ] Agreed retention period and deletion date for pilot data
- [ ] Production setup done, with a tested backup and restore (see [deployment.md](./deployment.md#how-to-move-to-the-pilot-setup))
- [ ] Demo accounts removed from the pilot deployment

## What makes a good pilot school

- Uses **Canvas**, so the planned importer works without extra changes.
- Has a registrar and a finance office willing to share enrollment and billing exports.
- Has a named DPO who can approve a data-sharing agreement within a few weeks.
- Has one program with enough students for the five-student minimum cohort rule.
- Is reachable by the team for in-person or online feedback sessions.

## How to approach a school

1. Prepare a one-page summary and the public demo link (see [deployment.md](./deployment.md#2-public-api-and-swagger-urls)).
2. Ask a faculty member or program head who already knows the team to introduce PlugLytics.
3. Demo the dashboard with synthetic data only.
4. Agree on the scope table above, then send the agreement and data-sharing agreement drafts.
5. Fill in this file and update item 5 in the [README](../../README.md#roadmap).

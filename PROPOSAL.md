# PlugLytics: Grant Proposal for Stellar Payments

## Executive summary

PlugLytics is a privacy-conscious learning analytics platform that helps educational institutions turn academic and financial activity into understandable decisions. It provides role-specific dashboards for students, instructors, and administrators through a secure REST API and a lightweight web interface.

PlugLytics is designed to complement Stellar Payments' merchant and payment capabilities: an institution can collect tuition and fees through Stellar Payments, reconcile them with enrollment activity, and expose collection, aging, refund, and scholarship metrics to authorized administrators.

## Problem

Many schools and training providers have student information spread across learning platforms, spreadsheets, payment systems, and registrars' tools. Staff struggle to answer basic questions quickly:

- Which students are at risk, and why?
- Which sections need attention?
- How much tuition is billed and collected?
- Which balances are overdue?
- Are scholarship and refund practices understandable?
- Which courses produce the best learning outcomes?

Existing analytics products may require cloud infrastructure, expose student-level records unnecessarily, or ignore the financial side of student success.

## The PlugLytics solution

The initial PlugLytics implementation provides:

- JWT authentication and RBAC for student, instructor, and administrator roles.
- Student-only access to progress, grades, deadlines, attendance, curriculum checklist, and personal risk indicators; class standing is excluded.
- Instructor access to owned sections, class folders, and student progress, grade, attendance, and assessment completion tracking.
- Admin enrollment, specialization, tuition, finance, academic quality, and operations analytics.
- Role-aware filters, configurable widget layouts, dark mode, and named dashboard presets.
- Swagger/OpenAPI documentation.
- Authenticated dashboards and interactive public Student, Instructor, and Admin previews.
- A responsive product website with role and use-case sections, branded navigation, and a direct VSIX download button.
- A PlugLytics-branded login screen using the navy-and-teal visual palette and supplied mark.
- A VS Code extension that connects to PlugLytics, starts and health-checks the local API when opening its dashboard, and supports a selected term or date range.
- Realistic seeded demo data and a zero-setup SQLite database.
- Stellar Testnet payments for invoices (XLM only), with Horizon confirmation, refunds, signed webhooks, and customer API keys. Testnet only; no real money.
- Automated tests run in GitHub Actions on every push and pull request to `main`.

The sample Software Development curriculum and upcoming demo events are served as static browser assets only; they are not included in API responses or database records. The grant-funded work would add institution-specific LMS ingestion and take the Stellar Testnet integration to a production-ready pilot so institutions can use consistent academic and merchant data with explainable analytics.

## Current website and application

The public website introduces PlugLytics, explains its student, instructor, and administrator use cases, describes privacy principles, and provides a **Download PlugLytics** button for the VS Code VSIX. It includes interactive previews for all three roles, with illustrative deadlines and events.

The dashboard sign-in screen uses the PlugLytics logo mark, a navy gradient background, and teal controls. Once signed in, the dashboard presents role-scoped analytics and saved widget layouts, with a prominent **Customize Dashboard** action for quickly choosing visible features. Report tables span their card content with reduced side spacing. The Student view organizes its curriculum checklist by year level, with term-by-term courses and completion percentage; Instructor class folders expose progress and assessment details for the instructor's sections; Admin views cover enrollment, specialization, tuition, and academic operations.

The extension refreshes role-permitted terms and dates from the authenticated PlugLytics API. It can also read dates from a manually configured LMS REST endpoint that returns JSON. This generic date reader does not scrape LMS web pages, implement provider-specific OAuth, paginate vendor APIs, or import enrollments, grades, courses, curriculum, attendance, or events. The current API is backed by synthetic SQLite demo records; static curriculum and event fixtures are used only by the browser demo. Provider adapters or import mappings are needed to populate analytics with institutional LMS data.

## Stellar Payments integration opportunity

Potential integration scope:

1. Create a documented merchant-payment adapter for invoice and payment imports.
2. Reconcile payment, refund, and dispute records (Stellar payments have no chargebacks; disputes come through anchors or card on-ramps) against student invoices.
3. Extend aging and collection reports without exposing individual student data in public views.
4. Support payment-method and scholarship analysis.
5. Produce auditable daily, weekly, and monthly financial summaries.
6. Provide CSV and API exports for approved school accounting systems.

The current repository includes a working Stellar **Testnet** integration: payment requests that convert invoices to XLM at a locked rate, confirmation through Horizon, late and memo-less payment matching, refunds, signed webhooks, and read-only customer API keys. It has not been used with real money: Mainnet (production) payments, USDC, anchors and settlement reports are not implemented, and no public deployment exists yet. Analytics still use seeded, synthetic records.

## Impact

The grant would allow institutions to:

- Identify at-risk students earlier while retaining privacy boundaries.
- Reduce manual reconciliation between enrollment and finance.
- Improve transparency for tuition collection and outstanding balances.
- Give instructors section-level evidence without administrator-only access.
- Let administrators compare courses, terms, specializations, and payment performance.

## Privacy and responsible use

PlugLytics is built around least-privilege access. Aggregate reports use minimum-cohort safeguards where applicable. Passwords are hashed and API responses use a consistent envelope without stack traces.

Students can access only their own records. Instructors can access identified roster and progress data only for sections they own. Sensitive aggregate reports use minimum-cohort safeguards where applicable.

## Proposed roadmap

| Phase | Deliverable | Target |
| --- | --- | --- |
| 1 | Grant-aligned repository, demo, and documentation | Complete |
| 2 | Stellar Testnet payment adapter: payment requests, Horizon confirmation, late and memo-less matching, refunds, signed webhooks, scoped API keys | Implemented on Testnet |
| 3 | Confirm LMS provider, map data, and implement a read-only ingestion adapter | 30 days after provider selection |
| 4 | Pilot payment and aging dashboards; reconciliation review with the pilot school | 90 days |
| 5 | Pilot with one school or training provider | 120 days |
| 6 | Security, accessibility, and deployment hardening | 180 days |

## Budget categories

Exact amounts should be determined with the grant administrator, but planned categories are:

- API and data integration engineering
- Payment reconciliation and data modeling
- Privacy and security review
- Frontend/dashboard implementation
- Test fixtures and automated tests
- Pilot onboarding and documentation
- Accessibility and deployment support

## Evaluation metrics

- Student at-risk precision against institution-validated outcomes.
- Collection-rate accuracy versus the merchant or accounting source.
- Time required to reconcile a term's tuition activity.
- Percentage of endpoints covered by automated authorization tests.
- Pilot staff task completion time.
- Percentage of aggregate endpoints protected by minimum-cohort rules.

## Demo

```bash
copy .env.example .env
npm install
npm run seed
npm run dev
```

Open the product website at `http://localhost:3000/public`, the dashboard at `http://localhost:3000/public/dashboard.html`, and API documentation at `http://localhost:3000/docs`. The VSIX download is available at `http://localhost:3000/public/pluglytics-0.1.0.vsix`.

Demo credentials are documented in [README.md](./README.md).

## Repository and contact

The public repository should remain a reproducible demo: grant reviewers can install dependencies, seed synthetic data, log in by role, exercise the dashboard, and run tests without cloud credentials.

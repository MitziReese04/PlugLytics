<h1 align="center">
  <img src="./logo/PlugLytics-logo-10-horizontal.png" alt="PlugLytics" width="420">
</h1>

<p align="center">
  <strong>Learning progress, made clear.</strong><br />
  Privacy-conscious LMS analytics for students, instructors, and administrators
</p>

<p align="center">
  <a href="#try-it-in-30-seconds">Try it in 30 seconds</a> •
  <a href="#problem--solution">Problem / Solution</a> •
  <a href="#features">Features</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#quick-start">Quick start</a>
</p>

<p align="center">
  <img src="./public/pluglytics-website-screenshot.png" alt="PlugLytics product website showing the branded navigation, learning analytics hero, and dashboard preview" width="100%">
</p>

## Live project

| Surface | Local URL | Status |
| --- | --- | --- |
| Public website | `http://localhost:3000/public` | Branded landing page with section navigation and direct extension download |
| Analytics dashboard | `http://localhost:3000/public/dashboard.html` | Available locally |
| REST API | `http://localhost:3000/api/v1` | Available locally |
| Swagger UI | `http://localhost:3000/docs` | Available locally |
| Health check | `http://localhost:3000/api/v1/health` | Available locally |
| VS Code plugin | [pluglytics-vscode](./pluglytics-vscode) | VSIX source packaged locally |
| Public deployment |  | **Not yet provided** |

PlugLytics is a zero-setup Learning Management System analytics API and role-aware web dashboard. It uses Node.js, Express, SQLite, JWT authentication, Zod validation, Chart.js, Swagger/OpenAPI, and a VS Code extension.

The product website has a responsive dark-gradient header with the PlugLytics logo, centered section links, and a direct **Download PlugLytics** VSIX button. The dashboard sign-in screen also uses the PlugLytics navy-and-teal palette and logo mark. The website preview is illustrative; the live dashboard uses the API's synthetic demo records.

The demo repository includes realistic synthetic data for:

- 500+ students
- 25 instructors
- 60 courses
- 6 specializations
- 4 academic terms

## Contents

- [Try it in 30 seconds](#try-it-in-30-seconds)
- [Problem / Solution](#problem--solution)
- [Features](#features)
- [Role-by-role access](#role-by-role-access)
- [How verification works](#how-verification-works)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Demo accounts](#demo-accounts)
- [API overview](#api-overview)
- [Universal filters](#universal-filters)
- [Metric formulas](#metric-formulas)
- [Privacy and security](#privacy-and-security)
- [VS Code plugin](#vs-code-plugin)
- [Tests](#tests)
- [CI](#ci)
- [Grant proposal](#grant-proposal)
- [Try Stellar testnet payments](#try-stellar-testnet-payments)
- [Roadmap](#roadmap)
- [Information still needed](#information-still-needed)
- [License](#license)

## Try it in 30 seconds

1. Open a terminal in the repository root.
2. Install dependencies, seed the demo database, and start the server:

```bash
npm install
npm run seed
npm run dev
```

3. Open `http://localhost:3000/public`.
4. Sign in with any [demo account](#demo-accounts).
5. Change term, course, section, or widget selections and observe the data update.
6. Open `http://localhost:3000/docs` for interactive API documentation.

Open the dashboard through the running PlugLytics server at `http://localhost:3000/public/dashboard.html`. Do not open `public/dashboard.html` directly from the file system; the browser needs the server's `/api/v1` routes for sign-in and analytics.

No external database, cloud account, or infrastructure is required for the demo.

## Problem / Solution

### Problem

Learning and financial information is often spread across LMS platforms, registrar spreadsheets, payment systems, and instructor reports. This makes it difficult to answer questions consistently:

- Which students need support, without exposing unnecessary personal records?
- Which sections, assignments, or quiz items are causing trouble?
- How much tuition is billed, collected, outstanding, refunded, or discounted?
- Which courses, specializations, and terms are performing well?
- Can the same evidence be used by different roles without broadening access?

### Solution

PlugLytics provides a single role-aware analytics surface backed by a versioned REST API.

| Layer | What it does |
| --- | --- |
| Public website | Branded product landing page with role/use-case information, section navigation, and a direct VSIX download |
| Analytics dashboard | Displays role-specific widgets and persisted custom layouts |
| REST API | Returns consistently structured LMS and finance analytics |
| Authentication | Verifies users through JWTs |
| RBAC | Limits endpoints and filters by role |
| Row-level checks | Resolves each student or instructor from the signed-in account |
| Privacy controls | Uses anonymous labels and a minimum cohort size of five |
| Export | Downloads table endpoints as CSV |

## Features

### Student analytics

- Course progress percentage by enrolled course
- Quiz, assignment, and exam grade averages
- GPA trend by academic term
- Upcoming deadlines and overdue items
- Attendance and time-on-platform data
- Anonymous class-standing percentile bands
- Plain-language at-risk indicators

### Instructor analytics

- Analytics limited to sections owned by the signed-in instructor
- Grade distribution histogram
- Submission rate and average score per assignment
- Hardest quiz questions by incorrect-response percentage
- Engagement by weekday and hour
- Anonymous at-risk student list
- Section and term comparisons
- Pass, failure, and withdrawal views

### Administrator analytics

- Enrollment totals by term, specialization, program, and year level
- Waitlist totals and seat utilization
- Retention and dropout rates
- Tuition billed, collected, outstanding, refunded, and discounted
- Income by specialization, program, and payment method
- Instructor cost and course margin where source cost data is available
- Revenue forecast
- GPA by specialization and course pass rates
- Instructor ratings
- Course popularity and enrollment timing

### Product features

- Role-aware widget catalog
- Custom widget selection and order
- Default filters and chart preferences
- Named dashboard presets
- Dark/light mode
- Page and result filtering
- CSV export
- Swagger/OpenAPI documentation
- Branded login screen and responsive public product website
- VS Code commands for dashboard, docs, health, server startup, account connection, and date filtering

## Role-by-role access

| Capability | Student | Instructor | Admin |
| --- | --- | --- | --- |
| Own course progress | Yes | - | Yes |
| Own grade trend | Yes | - | - |
| Own deadlines and risk | Yes | - | - |
| Anonymous class standing | Yes | - | - |
| Own sections | - | Yes | Yes |
| Grade distribution | - | Own sections | All |
| Assignment analytics | - | Own sections | All |
| Quiz item analysis | - | Own sections | All |
| Engagement heatmap | - | Own sections | All |
| At-risk students | Anonymous | Anonymous labels | Full analytics |
| Enrollment analytics | - | - | Yes |
| Finance analytics | - | - | Yes |
| Academic quality | - | - | Yes |
| Operations analytics | - | - | Yes |
| Custom dashboard | Yes | Yes | Yes |
| CSV export | Own tables | Own-section tables | All tables |

## How verification works

The demo does not rely on cryptographic verification because it is an LMS application, not a Stellar-anchored ledger product.

Instead, every API response follows the same verification and privacy model:

1. The JWT identifies the user.
2. RBAC middleware verifies the role.
3. Student and instructor endpoints apply row-level constraints.
4. The server validates every accepted query parameter.
5. Analytics calculate from the SQLite database.
6. Small cohorts are withheld or reduced to anonymous bands.
7. CSV and dashboard views use the same filtered server response envelope.

## Architecture

```text
Public website / browser dashboard / VS Code plugin
              |
              v
        Express API
   JWT + RBAC middleware
   Zod query validation
   analytics route modules
              |
              v
       SQLite database
  better-sqlite3 + SQL views
```

The public/static dashboard is served from `/public`. API routes are served under `/api/v1`. Swagger UI is served at `/docs`.

## Tech stack

| Layer | Package or technology |
| --- | --- |
| Runtime | Node.js |
| API | Express |
| Database | SQLite through `better-sqlite3` |
| Authentication | JWT |
| Password hashing | bcrypt |
| Validation | Zod |
| API docs | Swagger UI / OpenAPI |
| Tests | Jest and Supertest |
| Dashboard | Vanilla JavaScript and Chart.js |
| VS Code | VS Code Extension API |
| Security | Helmet and express-rate-limit |

## Repository layout

```text
PlugLytics/
|- public/                 # Public website and role-aware dashboard
|- logo/                   # Original PlugLytics brand image assets
|- pluglytics-vscode/      # VS Code extension source and VSIX
|- scripts/                # Database seed script
|- src/
|  |- middleware/          # JWT, RBAC, and query validation
|  |- routes/              # Auth and analytics endpoints
|  |- utils/               # Response envelope and CSV export
|  |- app.js               # Express application
|  |- db.js                # SQLite connection
|  |- schema.sql           # Tables, indexes, and views
|  |- openapi.js           # Swagger document
|- tests/                  # API and RBAC tests
|- .vscode/                # Debug, tasks, and extension launch setup
|- api.http                # REST Client request examples
|- PROPOSAL.md             # Grant proposal
|- README.md
```

## Quick start

### Prerequisites

- Node.js 20 or newer
- npm
- Windows PowerShell, macOS, or Linux
- Optional: VS Code REST Client extension

### Run the API and website

```bash
copy .env.example .env
npm install
npm run seed
npm run dev
```

macOS or Linux:

```bash
cp .env.example .env
npm install
npm run seed
npm run dev
```

Open:

- Public website: `http://localhost:3000/public`
- Dashboard: `http://localhost:3000/public/dashboard.html`
- Swagger: `http://localhost:3000/docs`

### Package the VS Code plugin

```bash
npm run package:plugin
code --install-extension pluglytics-vscode/pluglytics-0.1.0.vsix
```

## Environment variables

| Variable | Needed for | Default | Required |
| --- | --- | --- | --- |
| `PORT` | API listen port | `3000` | No |
| `JWT_SECRET` | Signing JWTs | Development fallback | Production: yes |
| `JWT_EXPIRES_IN` | JWT lifetime | `8h` | No |
| `DATABASE_PATH` | SQLite database location | `./data/pluglytics.db` | No |

Create a local `.env` from `.env.example`. Use a unique JWT secret outside development.

## Demo accounts

| Role | Email | Password |
| --- | --- | --- |
| Student | `student@pluglytics.local` | `Demo123!` |
| Instructor | `instructor@pluglytics.local` | `Demo123!` |
| Admin | `admin@pluglytics.local` | `Demo123!` |

Demo credentials are seeded only for local demonstration.

## API overview

### Authentication

| Method | Endpoint | Description |
| --- | --- | --- |
| POST | `/api/v1/auth/login` | Log in and receive a JWT |
| GET | `/api/v1/auth/me` | Return the signed-in user |

### Student

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/v1/student/progress` | Own course progress |
| GET | `/api/v1/student/grades` | Own grade and GPA trend |
| GET | `/api/v1/student/deadlines` | Upcoming and overdue items |
| GET | `/api/v1/student/standing` | Anonymous percentile band |
| GET | `/api/v1/student/risk` | Plain-language at-risk indicator |

### Instructor

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/v1/instructor/sections` | Own sections |
| GET | `/api/v1/instructor/distribution` | Grade distribution |
| GET | `/api/v1/instructor/assignments` | Assignment analytics |
| GET | `/api/v1/instructor/item-analysis` | Quiz item difficulty |
| GET | `/api/v1/instructor/engagement` | Weekday/hour activity |
| GET | `/api/v1/instructor/at-risk` | Anonymous at-risk list |
| GET | `/api/v1/instructor/compare` | Section and term comparisons |

### Admin

| Method | Endpoint group | Description |
| --- | --- | --- |
| GET | `/api/v1/admin/enrollment/*` | Enrollment and seat analytics |
| GET | `/api/v1/admin/finance/*` | Billing and collection analytics |
| GET | `/api/v1/admin/academics/*` | GPA, pass rates, and ratings |
| GET | `/api/v1/admin/operations/*` | Course popularity and operations |

### Dashboard

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/v1/widgets` | Role-available widget catalog |
| GET | `/api/v1/me/dashboard` | Read saved layout |
| PUT | `/api/v1/me/dashboard` | Save layout |
| POST | `/api/v1/me/dashboard/presets` | Save named preset |
| GET | `/api/v1/me/dashboard/render` | Render selected widgets |
| GET | `/api/v1/me/filter-options` | Fetch role-permitted term and activity dates |

The dashboard fetches available terms after sign-in and supports `from` and `to` date filters. The date options endpoint returns only dates associated with the caller's own records or sections, depending on role.

Example login:

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"student@pluglytics.local","password":"Demo123!"}'
```

Example authenticated request:

```bash
curl http://localhost:3000/api/v1/student/progress \
  -H "Authorization: Bearer YOUR_JWT"
```

Example CSV export:

```text
GET /api/v1/admin/enrollment/by-specialization?term=2025-1&format=csv
```

## Universal filters

Every analytics endpoint accepts the role-permitted subset of:

`term`, `from`, `to`, `specialization`, `program`, `course`, `section`, `instructor`, `yearLevel`, `status`, `groupBy`, `granularity`, `compare`, `sort`, `page`, `limit`

A disallowed filter returns HTTP `403` with a clear `FILTER_FORBIDDEN` response. Results use the same response envelope:

```json
{
  "data": {},
  "meta": {
    "filtersApplied": {},
    "generatedAt": "",
    "page": 1,
    "total": 0
  },
  "error": null
}
```

## Metric formulas

| Metric | Formula |
| --- | --- |
| Course progress | Submitted or late items / total assigned items x 100 |
| Submission rate | Submitted or late submissions / enrolled students x 100 |
| Average score | Sum of `(submission score / maximum score x 100)` / score count |
| Gross billed | Sum of invoice base amounts |
| Net billed | Sum of invoice final amounts: gross billed - scholarships - discounts + fees |
| Collection rate | Collected payments / net billed x 100 |
| Retention rate | Active enrollments / total enrollments x 100 |
| Dropout rate | Dropped or withdrawn enrollments / total enrollments x 100 |
| Pass rate | Enrollments with final grade >= 60 / graded enrollments x 100 |
| Seat utilization | Enrolled students / section capacity x 100 |
| Outstanding balance | Invoice final amount (after scholarships, discounts and fees) - payments |
| Aging bucket | Outstanding days since due date: 0-30, 31-60, or 60+ |
| Anonymous percentile band | Student average compared with an eligible cohort of at least five students |
| At-risk | 2+ missing submissions and/or attendance below 75%, plus plain-language reasons |

## Privacy and security

- JWT authentication with role claims
- Role-based route authorization
- Student identity derived from the signed-in account
- Instructor queries constrained to owned sections
- Minimum cohort size of five for privacy-sensitive aggregates
- Anonymous at-risk labels for instructor views
- Password hashing with bcrypt
- Helmet security headers
- Per-IP rate limiting
- Zod input/query validation
- Indexed SQLite queries
- Standardized error envelopes
- No stack traces returned to clients

This repository is a technical demo. Production use still requires a privacy review, threat model, audit logging, secret management, backups, HTTPS, and an appropriate deployment database strategy.

## VS Code plugin

The source is in [pluglytics-vscode](./pluglytics-vscode). A VSIX is also placed in [public](./public).

Commands:

- `PlugLytics: Open Dashboard`
- `PlugLytics: Open API Documentation`
- `PlugLytics: Start API`
- `PlugLytics: Check API Health`
- `PlugLytics: Connect Account`
- `PlugLytics: Refresh Available LMS Dates`
- `PlugLytics: Filter Dashboard by Date`
- `PlugLytics: Configure LMS Date API`
- `PlugLytics: Set LMS API Token`

The PlugLytics API URL is configurable with `pluglytics.baseUrl`. Once a user connects, the extension automatically refreshes role-scoped date choices from the API and can open the dashboard with the selected term or date range. An optional `pluglytics.lmsDateOptionsUrl` setting points to a JSON API on the institution's LMS; the extension can fetch ISO date fields and Unix-second or Unix-millisecond timestamps from that endpoint. Configure its URL with **PlugLytics: Configure LMS Date API** and store an optional bearer token with **PlugLytics: Set LMS API Token**.

This generic date fetcher requires a REST JSON endpoint and does not support LMS web-page scraping, provider-specific OAuth, or automatic pagination. Provider adapters or import mappings are still needed to populate PlugLytics analytics with institution data. The demo currently uses synthetic seeded data.

The public site's **Download PlugLytics** button downloads the VSIX at `public/pluglytics-0.1.0.vsix`. To run the extension's focused date-parser test, use `npm test` from `pluglytics-vscode`.

## Tests

```bash
npm test
```

Current coverage includes:

- Health response envelope
- Student filter restrictions
- Student-to-instructor authorization boundary
- Instructor-to-admin authorization boundary
- Finance collection-rate calculation
- Dashboard layout persistence
- Privacy-safe standing endpoint
- Role-scoped date options and inverted-range validation

To rerun a clean demo:

```bash
npm run seed
npm test
```

## CI

GitHub Actions workflows are not yet present in this repository.

## Grant proposal

See [PROPOSAL.md](./PROPOSAL.md) for the PlugLytics grant proposal, Stellar Payments integration opportunity, planned roadmap, impact, budget categories, and evaluation metrics.

The current project uses synthetic payment data. Stellar **testnet** payments work (see [Try Stellar testnet payments](#try-stellar-testnet-payments)); production (real-money) payments are not enabled.

See [docs/stellar/payments-api.md](./docs/stellar/payments-api.md) for the planned Stellar Payments API: the payment flow, endpoints, error codes, sandbox vs production setup, and testnet friendbot testing.

## Stellar Payments

Stellar **testnet** payments work: students can pay an invoice from the dashboard, and admins can see every payment request. **Production (real-money) payments are not enabled yet.** Some features in these documents are still planned:

- [Payments API](./docs/stellar/payments-api.md): payment flow, endpoints, customer API keys, webhook registration, error codes, and sandbox vs production
- [Webhooks](./docs/stellar/webhooks.md): event types, example payloads, signature verification, retries, and duplicate handling
- [Settlement and reconciliation](./docs/stellar/settlement.md): accepted assets (XLM and USDC), daily and weekly reconciliation, settlement reports, and handling mismatches
- [Approved payment methods](./docs/stellar/approved-payment-methods.md): which methods are accepted (USDC, XLM, anchors), who can use them, amount limits, and what is not accepted
- [Refunds and chargebacks](./docs/stellar/refunds-and-chargebacks.md): who can request a refund, the refund procedure, partial refunds, anchor and card on-ramp disputes, and record-keeping
- [Pilot budget and grant](./docs/stellar/pilot-budget-and-grant.md): pilot budget by category, grant amount, milestones, and reporting dates

## Try Stellar testnet payments

Testnet is Stellar's test network. Its XLM has **no real value**, so nothing here costs money. Production (real-money) payments are not enabled.

1. **Copy the Stellar settings into `.env`.** Copy the Stellar lines (everything from `# --- Stellar merchant credentials ---` down) from `.env.example` into your `.env`, and keep `STELLAR_ENV=sandbox`. Never put real keys in `.env.example` or any committed file.
2. **Create a testnet merchant account** (it receives the payments): open the [Stellar Laboratory](https://laboratory.stellar.org), switch to **Testnet**, and generate a keypair.
3. **Fund it with Friendbot**, which gives a new testnet account 10,000 test XLM:

   ```bash
   curl "https://friendbot.stellar.org?addr=YOUR_MERCHANT_PUBLIC_KEY"
   ```

4. **Add the `SANDBOX_` keys** in `.env`, replacing the placeholders:

   ```bash
   SANDBOX_MERCHANT_PUBLIC_KEY=<merchant G... key>
   SANDBOX_MERCHANT_SECRET_KEY=<merchant S... key>
   SANDBOX_WEBHOOK_SIGNING_SECRET=<any long random string>
   ```

5. **Restart the server** so it reads the new settings: stop `npm run dev` and start it again. (Run `npm run seed` first if you have not seeded since pulling.)
6. **Log in as the demo student** (`student@pluglytics.local` / `Demo123!`). In the **Payments** section, click **Pay with Stellar (Testnet)** on the unpaid 50 USD invoice. It asks for 125 XLM (sandbox rate: 1 USD = 2.5 XLM). Copy the **destination address**, **amount** and **memo**.
7. **Pay with a second testnet account:** generate another keypair in the Stellar Laboratory (Testnet) or use a wallet that supports testnet, fund it with Friendbot, and send exactly that amount of XLM to the destination address with the memo as a **text memo**, within 30 minutes. Without the memo, the payment cannot be matched.
8. The page checks every few seconds and shows **Completed** once the payment is found, or **Failed** with the reason. Log in as `admin@pluglytics.local` / `Demo123!` to see the request in **Stellar Payments**, linked to the transaction on [stellar.expert](https://stellar.expert/explorer/testnet).

The testnet is reset from time to time. After a reset, fund new accounts with Friendbot again.

## Roadmap

- [ ] Live public deployment with HTTPS
- [ ] Stellar Payments sandbox credentials and payment adapter
- [ ] Live invoice and payment reconciliation
- [ ] Revenue forecast endpoint
- [ ] Instructor cost and course-margin reporting
- [ ] LMS provider integration
- [ ] Automated CI and code-quality workflow
- [ ] Complete VS Code Marketplace publication
- [ ] Pilot institution approval and data-governance review
- [ ] Production backup, migration, logging, and monitoring setup
- [ ] Pilot user testing and accessibility audit
- [ ] Formal privacy and security review

## Information still needed

The following information is needed before the README and grant materials can be fully finalized:

1. Public production domain and hosting provider
2. Public API and Swagger URLs
3. Production database strategy and backup requirements
4. LMS provider(s) used by the pilot institution
5. Pilot institution name, program, and authorized contact
6. Real enrollment, retention, and financial definitions
7. Ledger and accounting system used for tuition reconciliation
8. Stellar Payments sandbox and production merchant credentials: **Documented, partly built** ([payments-api.md](./docs/stellar/payments-api.md#sandbox-vs-production))
   - Still missing: real sandbox keys in `.env`, and production merchant credentials (production is not enabled).
9. Stellar Payments API, webhook, and settlement documentation: **Documented, partly built** ([payments-api.md](./docs/stellar/payments-api.md), [webhooks.md](./docs/stellar/webhooks.md), [settlement.md](./docs/stellar/settlement.md))
   - Still missing: webhooks, refunds, daily reconciliation, and other planned endpoints are not built yet.
10. Approved payment methods and refund/chargeback procedures: **Documented, partly built** ([approved-payment-methods.md](./docs/stellar/approved-payment-methods.md), [refunds-and-chargebacks.md](./docs/stellar/refunds-and-chargebacks.md))
    - Still missing: the refund endpoint is not built yet; amount limits, refund windows, and the approved anchor list are placeholders.
11. Scholarship, discount, fee, and instructor-cost fields: **Documented, partly built** ([payments-api.md](./docs/stellar/payments-api.md#pricing-fields))
    - Still missing: no invoice endpoint or screen sets these fields yet.
12. Pilot budget, grant amount, milestones, and reporting dates: **Documented, partly built** ([pilot-budget-and-grant.md](./docs/stellar/pilot-budget-and-grant.md))
    - Still missing: the grant amount, budget amounts, and milestone and report dates are TODO.
13. User-testing population and target sample size
14. Security, accessibility, and compliance requirements
15. Confirmation that the supplied PlugLytics logo is approved for public and grant use
16. Screenshot or video assets for the public repository
17. License choice and maintainer information
18. Support, privacy, terms, and vulnerability-disclosure URLs
19. GitHub repository release/tag and publication strategy
20. VS Code Marketplace publisher ID

## License

**License:** not yet selected.

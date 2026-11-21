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
- Student-only access to progress, grades, deadlines, attendance, standing, and risk.
- Instructor-only access to own sections and anonymous at-risk views.
- Admin enrollment, finance, academic quality, and operations analytics.
- Universal filtering and CSV export.
- Custom widget layouts and named presets.
- Swagger/OpenAPI documentation.
- A static, role-aware dashboard.
- A responsive product website with role and use-case sections, branded navigation, and a direct VSIX download button.
- A PlugLytics-branded login screen using the navy-and-teal visual palette and supplied mark.
- A VS Code extension that connects to PlugLytics and opens the dashboard with a selected term or date range.
- Realistic seeded demo data and a zero-setup SQLite database.

The grant-funded integration would connect PlugLytics to Stellar Payments so institutions can use a consistent merchant payment workflow with analytics they can explain.

## Current website and application

The public website introduces PlugLytics, explains its student, instructor, and administrator use cases, describes privacy principles, and provides a **Download PlugLytics** button for the VS Code VSIX. The top navigation places the logo beside centered section links and uses the same dark navy visual treatment as the product hero.

The dashboard sign-in screen uses the PlugLytics logo mark, a navy gradient background, and teal controls. Once signed in, the dashboard presents role-scoped analytics and saved widget layouts.

The extension refreshes role-permitted terms and dates from the authenticated PlugLytics API. It can also read dates from a manually configured LMS REST endpoint that returns JSON. This generic date reader does not scrape LMS web pages, implement provider-specific OAuth, paginate vendor APIs, or import LMS records. Provider adapters or import mappings are still needed to populate analytics with institutional data. The current demo website and dashboard use synthetic data.

## Stellar Payments integration opportunity

Potential integration scope:

1. Create a documented merchant-payment adapter for invoice and payment imports.
2. Reconcile payment, refund, and chargeback records against student invoices.
3. Extend aging and collection reports without exposing individual student data in public views.
4. Support payment-method and scholarship analysis.
5. Produce auditable daily, weekly, and monthly financial summaries.
6. Provide CSV and API exports for approved school accounting systems.

No claim is made here that a live Stellar Payments integration exists in the current repository. The current application uses seeded, synthetic payment records. The integration is the next implementation milestone.

## Impact

The grant would allow institutions to:

- Identify at-risk students earlier while retaining privacy boundaries.
- Reduce manual reconciliation between enrollment and finance.
- Improve transparency for tuition collection and outstanding balances.
- Give instructors section-level evidence without administrator-only access.
- Let administrators compare courses, terms, specializations, and payment performance.

## Privacy and responsible use

PlugLytics is built around least-privilege access. Student and instructor reports suppress names or individual identifiers where cohort analytics may re-identify people. Aggregate views require a minimum cohort size of five. Passwords are hashed and API responses use a consistent envelope without stack traces.

## Proposed roadmap

| Phase | Deliverable | Target |
| --- | --- | --- |
| 1 | Grant-aligned repository, demo, and documentation | Complete |
| 2 | Stellar Payments sandbox/payment-adapter specification | 30 days |
| 3 | Secure invoice reconciliation and webhook ingestion | 60 days |
| 4 | Pilot payment and aging dashboards | 90 days |
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

Demo credentials are documented in [README.md](../README.md).

## Repository and contact

The public repository should remain a reproducible demo: grant reviewers can install dependencies, seed synthetic data, log in by role, exercise the dashboard, and run tests without cloud credentials.

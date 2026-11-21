# PlugLytics

**PlugLytics** is a zero-setup Learning Management System analytics API and role-aware dashboard for schools and training providers.

The project combines Node.js, Express, SQLite, JWT authentication, role-based access control, OpenAPI documentation, CSV export, and a vanilla-JS analytics dashboard. The repository includes realistic demo data for 500+ students, 25 instructors, 60 courses, 6 specializations, and 4 terms.

## Live project URLs

| Surface | URL |
| --- | --- |
| API base | `http://localhost:3000/api/v1` |
| Dashboard | `http://localhost:3000/public` |
| Swagger | `http://localhost:3000/docs` |
| Health | `http://localhost:3000/api/v1/health` |

## Quick start

Requirements: Node.js 20+ and npm.

```bash
copy .env.example .env
npm install
npm run seed
npm run dev
```

Open `http://localhost:3000/public`.

## Demo accounts

| Role | Email | Password |
| --- | --- | --- |
| Student | `student@pluglytics.local` | `Demo123!` |
| Instructor | `instructor@pluglytics.local` | `Demo123!` |
| Admin | `admin@pluglytics.local` | `Demo123!` |

## Role-by-role features

| Feature | Student | Instructor | Admin |
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
| At-risk students | Anonymous labels | Anonymous labels | Full analytics |
| Enrollment analytics | - | - | Yes |
| Finance analytics | - | - | Yes |
| Academic quality | - | - | Yes |
| Operations analytics | - | - | Yes |
| Custom dashboard | Yes | Yes | Yes |
| CSV export | Own tables | Own-section tables | All tables |

## API groups

- Authentication: `POST /auth/login`, `GET /auth/me`
- Health: `GET /health`
- Student: `/student/progress`, `/student/grades`, `/student/deadlines`, `/student/standing`, `/student/risk`
- Instructor: `/instructor/sections`, `/instructor/distribution`, `/instructor/assignments`, `/instructor/item-analysis`, `/instructor/engagement`, `/instructor/at-risk`, `/instructor/compare`
- Admin enrollment: `/admin/enrollment/summary`, `/admin/enrollment/by-specialization`, `/admin/enrollment/year-level`, `/admin/enrollment/retention`, `/admin/enrollment/seat-utilization`
- Admin finance: `/admin/finance/overview`, `/admin/finance/income-by-specialization`, `/admin/finance/outstanding`, `/admin/finance/refunds`
- Admin academics: `/admin/academics/gpa-by-specialization`, `/admin/academics/pass-rates`, `/admin/academics/ratings`
- Admin operations: `/admin/operations/course-popularity`
- Dashboard: `/widgets`, `/me/dashboard`, `/me/dashboard/presets`, `/me/dashboard/render`

## Universal filters

`term`, `from`, `to`, `specialization`, `program`, `course`, `section`, `instructor`, `yearLevel`, `status`, `groupBy`, `granularity`, `compare`, `sort`, `page`, `limit`.

The server rejects any filter outside the caller's role with HTTP `403` and a clear message. Append `format=csv` to table endpoints to download CSV.

## Metric formulas

| Metric | Formula |
| --- | --- |
| Course progress | Submitted or late items / total assigned items x 100 |
| Submission rate | Submitted or late submissions / enrolled students x 100 |
| Average score | Sum of `(submission score / maximum score x 100)` / score count |
| Collection rate | Collected payments / tuition billed x 100 |
| Retention rate | Active enrollments / total enrollments x 100 |
| Dropout rate | Dropped or withdrawn enrollments / total enrollments x 100 |
| Pass rate | Enrollments with final grade >= 60 / graded enrollments x 100 |
| Seat utilization | Enrolled students / section capacity x 100 |
| Anonymous percentile band | Position of the student's average against the eligible cohort, reported only at cohort sizes >= 5 |
| At-risk | 2+ missing submissions and/or attendance below 75%; reasons are shown in plain language |

## Privacy and security

- JWT authentication and role checks.
- Student records are resolved from the signed-in user; names are never accepted as a student lookup.
- Instructor queries start with the signed-in instructor's section ownership.
- Student and instructor aggregates require a minimum cohort of five where standing or aggregate analytics could identify a person.
- Password hashing with bcrypt.
- Helmet, a 300-request-per-minute rate limit, Zod validation, indexed queries, and standardized error envelopes.
- No stack traces are returned to API consumers.

## Tests

```bash
npm test
```

Tests cover health, student/instructor/admin authorization boundaries, finance calculation, dashboard persistence, and privacy-safe standing.

## VS Code plugin

The installable PlugLytics extension is in [pluglytics-vscode](./pluglytics-vscode).

It adds commands for opening the dashboard, opening Swagger, starting the API, and checking API health.

## Grant proposal

See [PROPOSAL.md](./PROPOSAL.md) for the Stellar Payments grant proposal and implementation roadmap.

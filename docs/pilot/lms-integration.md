# PlugLytics LMS Integration: Canvas

> **Status: documented, not built.** This covers README item 4: the LMS used by the pilot institution. The pilot targets **Canvas LMS**. Today PlugLytics only reads its own seeded demo data. The Canvas importer and the LTI launch described here are planned work. Values marked **TODO** must be confirmed with the pilot school's Canvas administrator.

## Contents

- [Pilot LMS](#pilot-lms)
- [How PlugLytics connects to Canvas](#how-pluglytics-connects-to-canvas)
- [What to ask the Canvas administrator](#what-to-ask-the-canvas-administrator)
- [Data mapping: Canvas to PlugLytics](#data-mapping-canvas-to-pluglytics)
- [Canvas API endpoints the importer will use](#canvas-api-endpoints-the-importer-will-use)
- [Sync schedule](#sync-schedule)
- [Gaps: data Canvas does not have](#gaps-data-canvas-does-not-have)
- [Privacy rules for the import](#privacy-rules-for-the-import)
- [Build plan](#build-plan)
- [Open decisions](#open-decisions)
- [Sources](#sources)

## Pilot LMS

| Item | Value |
| --- | --- |
| LMS | Canvas LMS (Instructure) |
| Canvas URL | TODO, for example `https://<school>.instructure.com` |
| Hosting | TODO: Instructure-hosted (cloud) or the school's own open-source Canvas server |
| Quiz engine | TODO: Classic Quizzes, New Quizzes, or both (changes how item analysis is imported) |
| Attendance tool | TODO: Canvas Roll Call Attendance, or the school's own attendance records |
| Canvas admin contact | TODO (see [pilot-institution.md](./pilot-institution.md)) |

## How PlugLytics connects to Canvas

Two connections, in this order:

| Step | Connection | What it gives PlugLytics | Needed for the pilot? |
| --- | --- | --- | --- |
| 1 | **Canvas REST API** with an API developer key (OAuth 2) | Read-only import of terms, courses, sections, enrollments, assignments, submissions, scores and activity | Yes |
| 2 | **LTI 1.3** with an LTI developer key | Opens the PlugLytics dashboard inside Canvas, with Canvas sign-in instead of a separate PlugLytics password | Nice to have; after the import works |

Canvas Data 2, Instructure's bulk data export for whole institutions, is an alternative to the REST API for large schools. It is out of scope for a one-program pilot.

## What to ask the Canvas administrator

1. Create an **API developer key** for PlugLytics, with **scopes enforced** and only the read scopes for the endpoints in [the endpoint list](#canvas-api-endpoints-the-importer-will-use).
2. Authorize it with a dedicated Canvas account (for example `pluglytics-integration`) that can see only the pilot program's sub-account, not the whole school.
3. Give the Canvas term IDs and the sub-account ID for the pilot program.
4. Later, create an **LTI 1.3 developer key** for the dashboard launch.
5. Confirm the API rate limits PlugLytics should respect.

Store the client ID, secret and tokens only in Render environment variables, never in the repository (same rule as the Stellar keys in `.env.example`).

## Data mapping: Canvas to PlugLytics

| PlugLytics table | Canvas source | Notes |
| --- | --- | --- |
| `terms` | Enrollment terms | Map `start_at` / `end_at` to `start_date` / `end_date` |
| `courses` | Courses | Keep the Canvas course ID as an external ID |
| `sections` | Course sections | `capacity` is not in Canvas: take it from the registrar (TODO) |
| `instructors` | Users with a teacher enrollment | |
| `students` | Users with a student enrollment | `program_id` and `year_level` are not in Canvas: take them from the registrar or the SIS ID format (TODO) |
| `enrollments` | Student enrollments | Canvas `active` → `active`, `completed` → `completed`, `inactive` or `deleted` → `dropped`. Canvas has no `withdrawn` or `waitlisted`: take those from the registrar. `final_grade` from the enrollment's final score |
| `assignments` | Assignments | `kind`: quiz if it is an online quiz, exam if the assignment group is named like an exam (TODO: agree on a rule), otherwise assignment. `max_score` = points possible |
| `submissions` | Submissions | `submitted` when submitted on time, `late` when Canvas marks it late, `missing` when Canvas marks it missing |
| `quiz_questions`, `quiz_responses` | Classic Quizzes statistics, or New Quizzes reports | TODO: depends on the quiz engine |
| `attendance_logs` | Roll Call Attendance reports, or registrar attendance | Not in the core Canvas API (see [Gaps](#gaps-data-canvas-does-not-have)) |
| `activity_logs` | Course analytics: page views and participations per student | Daily totals are enough for the engagement heatmap |
| `invoices`, `payments`, `refunds` | Not in Canvas | From the school's accounting system (see [accounting-and-ledger.md](./accounting-and-ledger.md)) |

Each imported row keeps its Canvas ID in an external-ID column (TODO: add these columns), so re-running the import updates rows instead of duplicating them.

## Canvas API endpoints the importer will use

All are `GET` requests. Canvas pages its results with `Link` headers, so the importer must follow the `next` links.

| Data | Endpoint |
| --- | --- |
| Terms | `/api/v1/accounts/:account_id/terms` |
| Courses in the pilot sub-account | `/api/v1/accounts/:account_id/courses` |
| Sections | `/api/v1/courses/:course_id/sections` |
| Enrollments | `/api/v1/courses/:course_id/enrollments` |
| Assignments | `/api/v1/courses/:course_id/assignments` |
| Submissions for all students | `/api/v1/courses/:course_id/students/submissions` |
| Per-student activity and on-time/late summary | `/api/v1/courses/:course_id/analytics/student_summaries` |
| Daily course activity | `/api/v1/courses/:course_id/analytics/activity` |

TODO: confirm each endpoint and its scope against the pilot school's Canvas instance before building.

## Sync schedule

| Sync | When | What |
| --- | --- | --- |
| Full import | Once at the start of the pilot term | Everything in the mapping table |
| Nightly update | Every night, after the [nightly backup](./deployment.md#backup-requirements) | Enrollments, submissions and activity changed since the last run |
| On demand | Admin button (TODO) | Same as nightly, for one course |

The importer must slow down when Canvas reports a low remaining rate limit, and must never run during the school's exam-week peak hours (TODO: agree on hours).

## Gaps: data Canvas does not have

| PlugLytics needs | Why it is missing | Where to get it |
| --- | --- | --- |
| Attendance below 75% (at-risk rule) | Core Canvas has no attendance records | Roll Call Attendance reports, or the registrar. Without attendance, the at-risk rule uses missing submissions only. TODO |
| Withdrawn and waitlisted status | Canvas tracks course access, not registration | Registrar |
| Section capacity (seat utilization) | Not a Canvas field | Registrar |
| Program, specialization, year level | Not standard Canvas fields | Registrar or SIS |
| Tuition, payments, refunds, scholarships | Canvas is not a billing system | Accounting system (item 7) |
| Instructor ratings | Course evaluations are often a separate tool | TODO |

## Privacy rules for the import

These follow the privacy rules already in the [README](../../README.md#privacy-and-security) and the Data Privacy Act of 2012 (RA 10173):

- Import only the pilot program's courses, and only the fields in the mapping table.
- Do not import message contents, discussion text, submission files or comments. Counts and scores are enough.
- Keep student names only if the dashboard needs them; otherwise store the Canvas ID and the student number.
- Canvas tokens are read-only and stored only as secrets.
- When the pilot ends, delete the imported data and revoke the developer key (TODO: agree on the date in the data-sharing agreement).

## Build plan

1. Add external-ID columns and an `import_runs` table (when each import ran, counts, errors).
2. Build `src/integrations/canvas/` with a client that pages, retries and respects rate limits.
3. Write mappers for each table above, with tests that use recorded Canvas responses (no live Canvas in tests).
4. Add `npm run import:canvas` for the full and nightly imports.
5. Run it against a Canvas **test or beta instance** before production data.
6. Add the LTI 1.3 launch.

## Open decisions

- [ ] The pilot school's Canvas URL, and whether it is cloud-hosted or self-hosted
- [ ] Classic Quizzes or New Quizzes
- [ ] Attendance source
- [ ] Rule for which assignments count as exams
- [ ] Which registrar data fills the gaps, and in what format (CSV upload is the simplest)
- [ ] Whether the LTI launch is part of the pilot

## Sources

- [Canvas LMS REST API documentation (Instructure Developer Documentation)](https://developerdocs.instructure.com/services/canvas)
- [Canvas Analytics API](https://developerdocs.instructure.com/services/canvas/resources/analytics)

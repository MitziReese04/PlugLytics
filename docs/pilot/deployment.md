# PlugLytics Deployment, Public URLs, and Database Plan

> **Status: documented, partly built.** This covers README items 1–3: the hosting provider and domain, the public API and Swagger URLs, and the production database and backup plan. The Render Blueprint ([render.yaml](../../render.yaml)) and the `migrate` and `backup` scripts exist. Nothing is deployed yet. Values marked **TODO** need a group decision.

## Contents

- [Summary](#summary)
- [1. Hosting provider and domain](#1-hosting-provider-and-domain)
- [2. Public API and Swagger URLs](#2-public-api-and-swagger-urls)
- [3. Production database strategy](#3-production-database-strategy)
- [Backup requirements](#backup-requirements)
- [How to deploy the demo](#how-to-deploy-the-demo)
- [How to move to the pilot setup](#how-to-move-to-the-pilot-setup)
- [Open decisions](#open-decisions)

## Summary

| Item | Decision |
| --- | --- |
| Hosting provider | [Render](https://render.com), Singapore region (closest Render region to the Philippines) |
| Demo instance | Free web service, rebuilt from seeded demo data on every deploy |
| Pilot instance | Paid Starter web service with a 1 GB persistent disk |
| Public domain | `pluglytics.onrender.com` first (TODO: confirm the service name is free), then a custom domain (TODO) |
| HTTPS | Render's managed TLS certificates, on both the `onrender.com` and the custom domain |
| Database | SQLite on the persistent disk for one pilot school; Render Postgres when there is more than one school |
| Backups | Nightly checked copy with `npm run backup`, 7 kept on the disk, plus an off-site copy (TODO: where) |

## 1. Hosting provider and domain

### Why Render

- PlugLytics is a single Node.js + Express service with a SQLite file. Render runs that directly from the GitHub repository with no Docker setup.
- Render's free web services support custom domains and managed TLS certificates, so the demo can be public over HTTPS at no cost ([Render: Deploy for free](https://render.com/docs/free)).
- Render has a Singapore region, which keeps latency low for users in the Philippines.

### What the free instance can and cannot do

| | Free (demo) | Starter + disk (pilot) |
| --- | --- | --- |
| Always on | No: spins down after 15 minutes without traffic and takes about a minute to wake up | Yes |
| Keeps data after a restart or deploy | No: the filesystem is ephemeral, so a local SQLite database is lost | Yes, for files under the disk's mount path |
| Persistent disk | Not available | Available ([Render: Persistent disks](https://render.com/docs/disks)) |
| Good for | Showing the demo to the panel, grant reviewers, and testers | Real school data |

Because the free instance forgets everything on restart, the demo Blueprint rebuilds the database with `npm run seed` on every deploy. Dashboard layouts and testnet payment requests saved during a demo are lost when it spins down. That is acceptable for a demo and **not** acceptable for the pilot.

### Domain plan

1. **Now:** use the free Render subdomain, `https://pluglytics.onrender.com` (TODO: confirm the service name `pluglytics` is available when the service is created; Render adds a suffix if it is taken).
2. **Before the pilot:** register a custom domain and point it to Render (TODO: group decision on the name and who pays for it). Suggested layout:

| Host | Purpose |
| --- | --- |
| `pluglytics.<domain>` or `<domain>` | Website, dashboard, API and Swagger (one service) |
| `status.<domain>` | Optional later: uptime status page |

Keep one host for the website and the API, because the dashboard calls `/api/v1` on the same origin.

## 2. Public API and Swagger URLs

All public URLs come from one Render service. Replace `<host>` with `pluglytics.onrender.com` now, and with the custom domain later.

| Surface | Public URL | Local URL |
| --- | --- | --- |
| Website | `https://<host>/public` | `http://localhost:3000/public` |
| Analytics dashboard | `https://<host>/public/dashboard.html` | `http://localhost:3000/public/dashboard.html` |
| REST API base | `https://<host>/api/v1` | `http://localhost:3000/api/v1` |
| Swagger UI | `https://<host>/docs` | `http://localhost:3000/docs` |
| Health check | `https://<host>/api/v1/health` | `http://localhost:3000/api/v1/health` |
| Proposal download | `https://<host>/proposal` | `http://localhost:3000/proposal` |

Notes:

- Render uses `/api/v1/health` as the health check ([render.yaml](../../render.yaml)), so a broken deploy is not put live.
- Render sits behind one proxy, so the service sets `TRUST_PROXY=1`. Without it, the rate limiter would see every visitor as the same IP address and the 300-requests-per-minute limit would be shared by everyone.
- The demo accounts (`Demo123!`) are public on the demo. They must be removed before any real data is loaded.
- **TODO:** once deployed, update the Live project table in the [README](../../README.md#live-demo-on-vercel) with the real URLs.

## 3. Production database strategy

| Stage | Database | Where it lives | When |
| --- | --- | --- | --- |
| Demo | SQLite, seeded | Inside the deployed service; rebuilt on every deploy | Now |
| Pilot (one school) | SQLite in WAL mode | Render persistent disk at `/var/data/pluglytics.db` | When a pilot school signs on |
| Scale (more than one school, or more than one server) | PostgreSQL | Render Postgres | TODO: after the pilot |

### Why SQLite is enough for one pilot school

- One school's term of LMS and finance data is small. The full demo database, with 500+ students and 2,000 invoices, is about 3.6 MB.
- The app already uses SQLite's WAL mode, so reads (dashboards) do not block writes.
- It keeps the pilot cheap and simple: no separate database service.

### Limits to plan for

- A service with a persistent disk runs as **one instance**. It cannot be scaled out to several servers, and each deploy has a few seconds of downtime, because Render stops the old instance before starting the new one.
- Build and pre-deploy commands cannot see the disk, which is why the pilot runs `npm run migrate` as part of the start command ([Render: Persistent disks](https://render.com/docs/disks)).
- Moving to PostgreSQL later is real work. The code uses `better-sqlite3`, which is synchronous, and SQLite-specific SQL (for example `julianday()` and a generated `final_amount` column). TODO: plan this port before onboarding a second school.

### Schema changes

- `npm run seed` **replaces all data**. Use it only for the demo and for local development.
- `npm run migrate` creates any missing tables, indexes, views and triggers from `src/schema.sql` and never deletes data. The pilot service runs it on every start.
- `migrate` does not change tables that already exist, for example adding a column. TODO: add versioned migrations before the pilot.

## Backup requirements

| Requirement | Target |
| --- | --- |
| Maximum data loss (RPO) | 24 hours |
| Time to restore service (RTO) | 4 hours |
| Backup frequency | Daily, at night (Philippine time), plus before every deploy that changes the schema |
| On-disk copies kept | 7 (`BACKUP_KEEP`) |
| Off-site copies kept | 4 weekly and 12 monthly (TODO: confirm with the pilot school's data protection officer) |
| Off-site location | TODO: group decision, for example the school's own cloud storage |
| Encryption | Off-site copies must be encrypted. Only the PlugLytics admins and the school's DPO may access them |
| Restore test | Once a month, restore the newest copy to a local machine and run `npm test` against it |
| Retention limit | Delete copies older than the agreed period, as the Data Privacy Act of 2012 (RA 10173) does not allow keeping personal data longer than needed |

### How backups work

`npm run backup` ([scripts/backup-db.js](../../scripts/backup-db.js)):

1. Copies the database with SQLite's online backup, which is safe while the server is running.
2. Turns the copy into a single self-contained file.
3. Runs `PRAGMA integrity_check` on the copy and stops with an error if it fails.
4. Keeps the newest `BACKUP_KEEP` copies (default 7) in `BACKUP_DIR` (default: a `backups` folder next to the database) and deletes older ones.

Render also snapshots each persistent disk once every 24 hours and keeps the snapshots for seven days. Treat that as a second safety net only. Render advises against restoring a disk snapshot to recover a database, because the database may come back corrupted ([Render: Persistent disks](https://render.com/docs/disks)). Restore from a checked `npm run backup` copy instead.

**Not built yet:**

- Scheduling. Render cron jobs run as separate services and cannot read another service's disk. TODO: run the backup on a timer inside the web service, or trigger it from an admin endpoint.
- Copying backups off-site.

### How to restore

1. Stop the service (Render Dashboard → Suspend).
2. Replace `/var/data/pluglytics.db` with the chosen backup copy, and delete any `pluglytics.db-wal` and `pluglytics.db-shm` files next to it.
3. Resume the service. `npm run migrate` runs on start, then check `/api/v1/health`.

## How to deploy the demo

1. Push the branch that contains `render.yaml` to GitHub.
2. In Render: **New → Blueprint**, pick the `PlugLytics` repository and the branch.
3. When asked, fill in the Stellar sandbox values (`SANDBOX_MERCHANT_PUBLIC_KEY`, `SANDBOX_MERCHANT_SECRET_KEY`, `SANDBOX_WEBHOOK_SIGNING_SECRET`). Render generates `JWT_SECRET` automatically.
4. Click **Apply**. The first build runs `npm ci && npm run seed`.
5. Open `https://<host>/api/v1/health`, then `https://<host>/public`.

`autoDeploy` is off, so pushes do not deploy by themselves. Deploy from the Render Dashboard when the team agrees.

## How to move to the pilot setup

Apply the "Pilot setup" block at the bottom of [render.yaml](../../render.yaml):

1. Change the plan to `starter` and add the disk (`/var/data`, 1 GB).
2. Set `DATABASE_PATH=/var/data/pluglytics.db` and `BACKUP_DIR=/var/data/backups`.
3. Change the build command to `npm ci` (no seed) and the start command to `npm run migrate && npm start`.
4. Remove the demo accounts and set a new `JWT_SECRET`.
5. Run the first backup and a restore test before importing any school data.

## Open decisions

- [ ] Render service name (decides the `onrender.com` subdomain)
- [ ] Custom domain name, registrar, and who pays
- [ ] Who on the team owns the Render account and receives alerts
- [ ] Off-site backup location and retention periods (with the pilot school's DPO)
- [ ] How the nightly backup is scheduled
- [ ] When to move from SQLite to PostgreSQL

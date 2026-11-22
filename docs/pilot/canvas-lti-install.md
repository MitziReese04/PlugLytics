# Installing PlugLytics in Canvas (LTI 1.3)

> **Status: working, tested in a real Canvas.** PlugLytics can be launched from Canvas as an LTI 1.3 tool: a **PlugLytics** tab in each course (and in the admin account menu) opens the dashboard inside Canvas, signed in as the right person with the right role. It was tested end to end in an Instructure-hosted Canvas on Nov 22, 2026 (see [Tested in a real Canvas](#tested-in-a-real-canvas)) and is covered by automated tests against a simulated Canvas (`tests/lti.test.js`). Installing it needs a Canvas **admin**; a Canvas Free-for-Teacher account cannot create LTI developer keys.

## Contents

- [What is built](#what-is-built)
- [How a launch works](#how-a-launch-works)
- [Step 1: Set up PlugLytics](#step-1-set-up-pluglytics)
- [Step 2: The Canvas admin creates the developer key](#step-2-the-canvas-admin-creates-the-developer-key)
- [Step 3: Connect PlugLytics to that key](#step-3-connect-pluglytics-to-that-key)
- [Step 4: Install the app in Canvas](#step-4-install-the-app-in-canvas)
- [Who can sign in, and how accounts are linked](#who-can-sign-in-and-how-accounts-are-linked)
- [Settings](#settings)
- [Testing the launch](#testing-the-launch)
- [Testing locally with a tunnel](#testing-locally-with-a-tunnel)
- [Tested in a real Canvas](#tested-in-a-real-canvas)
- [Known limits](#known-limits)
- [Troubleshooting](#troubleshooting)

## What is built

| Part | Address | What it does |
| --- | --- | --- |
| Login initiation | `GET` or `POST /lti/login` | Canvas starts a launch here. PlugLytics checks the issuer, client ID and deployment, then sends the browser to Canvas's authorization endpoint |
| Launch | `POST /lti/launch` | Canvas posts a signed `id_token`. PlugLytics verifies it with Canvas's public keys, maps the role, signs the user in, and opens the dashboard |
| Tool public key | `GET /lti/jwks` | PlugLytics' public key (the private key never leaves the server) |
| Canvas configuration | `GET /lti/config.json` | The JSON a Canvas admin pastes into a new LTI developer key |
| Framing | `FRAME_ANCESTORS` setting | Lets Canvas show the dashboard inside its page |
| Account linking | `npm run lti:link` | Links a Canvas user to a PlugLytics account by hand (needed for admins) |

Not built yet: grade passback and roster sync (LTI Advantage services), opening the dashboard filtered to the Canvas course, and the Canvas data importer ([lms-integration.md](./lms-integration.md)). Until the importer exists, the dashboard shows PlugLytics data, not the Canvas course's data.

No new library was added: tokens are checked with Node's built-in `crypto` and the `jsonwebtoken` package PlugLytics already uses.

## How a launch works

1. A user clicks **PlugLytics** in the Canvas course menu.
2. Canvas calls `/lti/login`. PlugLytics creates a one-time **nonce** and a signed, 10-minute **state**, and sends the browser to Canvas's authorization endpoint.
3. Canvas posts a signed `id_token` to `/lti/launch`.
4. PlugLytics checks:
   - the token is signed by Canvas (Canvas's public key set, refreshed when Canvas rotates keys);
   - the issuer, audience (client ID) and deployment ID are the ones configured;
   - the token is less than 10 minutes old;
   - the nonce matches the state and has never been used (no replays);
   - it is an LTI 1.3 resource link launch.
5. The Canvas role becomes a PlugLytics role, and the Canvas user is matched to their PlugLytics account.
6. PlugLytics signs a normal PlugLytics token and opens `/public/dashboard.html`. The token is passed in the URL fragment (never sent to a server or logged) and stored by `public/lti-handoff.js`, then removed from the address bar.

From then on, every existing role check and privacy rule applies exactly as with a normal sign-in.

## Step 1: Set up PlugLytics

1. Create the tool's key pair:

   ```bash
   npm run lti:keygen
   ```

   Copy the printed `LTI_PRIVATE_KEY="..."` line into `.env` locally, or into the host's environment variables (Vercel: Project → Settings → Environment Variables). **Never commit it.**

2. Set the public address and allow Canvas to frame the dashboard:

   ```bash
   LTI_TOOL_URL=https://pluglytics.xyz
   FRAME_ANCESTORS=https://*.instructure.com
   ```

   For a self-hosted Canvas, use its own address instead, for example `FRAME_ANCESTORS=https://canvas.school.edu.ph`.

3. Deploy, then open `https://pluglytics.xyz/lti/config.json`. It should show the PlugLytics configuration. If it says to set `LTI_PRIVATE_KEY`, the key is missing or not valid.

## Step 2: The Canvas admin creates the developer key

In Canvas, as an admin:

1. **Admin → (account) → Developer Keys → + Developer Key → + LTI Key.**
2. **Method:** Enter URL, and paste `https://pluglytics.xyz/lti/config.json`. (Or choose Paste JSON and paste the file's contents.)
3. **Redirect URIs:** `https://pluglytics.xyz/lti/launch`
4. **Key name:** PlugLytics. **Owner email:** the PlugLytics technical lead.
5. **Save**, then switch the key's **State** to **ON**.
6. Copy the **Client ID**, the long number in the Details column.

Newer Canvas versions show a banner saying LTI tools are now managed in **Canvas Apps**. Creating the key under Developer Keys still works, and the key then appears in **Admin → Apps → Manage**. If the form has no **Enter URL** option, choose manual entry and use the values from `/lti/config.json`: Target Link URI and placement URIs `…/lti/launch`, OpenID Connect Initiation URL `…/lti/login`, Public JWK URL `…/lti/jwks`, **Privacy Level: Public** (otherwise Canvas sends no email or name), and the **Course Navigation** and **Account Navigation** placements.

## Step 3: Connect PlugLytics to that key

Add these settings to PlugLytics and redeploy:

```bash
LTI_CLIENT_ID=<Client ID from step 2>
LTI_DEPLOYMENT_IDS=<Deployment ID from step 4>
```

The Deployment ID only exists after step 4, so this step is done in two passes: set `LTI_CLIENT_ID` now, and `LTI_DEPLOYMENT_IDS` right after step 4. Launches are refused until both are set.

## Step 4: Install the app in Canvas

**With Canvas Apps** (newer Canvas):

1. **Admin → (account) → Apps → Manage**, and open **PlugLytics**. If it is not listed, use **Install a New App** with the Client ID.
2. **Copy Client ID** at the top gives the exact Client ID for `LTI_CLIENT_ID`.
3. On the **Availability and Exceptions** tab, the deployment shows its **Deployment ID** (for example `5872:5e1e…`). Copy it into `LTI_DEPLOYMENT_IDS`.
4. If the deployment says **Not Available**, click the **pencil** and set it to **Available**. Until then, the PlugLytics tab does not appear in Canvas menus.

**With the classic Apps page:**

1. **Admin → (account or the pilot sub-account) → Settings → Apps → View App Configurations → + App.**
2. **Configuration Type:** By Client ID. Paste the Client ID and **Submit**, then **Install**.
3. Open the app's gear menu → **Deployment Id**, and copy it into `LTI_DEPLOYMENT_IDS` (step 3). Several deployments can be listed, separated by commas.

Installing on the pilot program's **sub-account** instead of the whole school limits the PlugLytics tab to the pilot courses.

## Who can sign in, and how accounts are linked

| Canvas role (in the launch) | PlugLytics role |
| --- | --- |
| Student (Learner) | `student` |
| Teacher (Instructor), TA | `instructor` |
| Account admin (institution or system Administrator) | `admin` |
| Anything else (observer, designer only) | Not allowed |

PlugLytics **never creates accounts** from a launch: students need a program and student number, which Canvas does not send. Instead, each Canvas user is linked once to an existing PlugLytics account, and the link is remembered:

- **Students and instructors** are linked automatically on their first launch when their Canvas email matches a PlugLytics account **with the same role**. A Canvas student can never open a PlugLytics instructor or admin account.
- **Admins are never linked by email**, because an email address shown by Canvas is not strong enough proof for access to finance data. Link them by hand: the admin opens PlugLytics from Canvas once, the "not linked" page shows their **Canvas user ID**, and someone with server access runs:

  ```bash
  npm run lti:link -- admin@school.edu.ph <canvas-user-id>
  ```

- Anyone without a matching account sees a "not linked" page with their Canvas user ID, so the PlugLytics administrator knows whom to add.

To change which roles may link by email, set `LTI_EMAIL_LINK_ROLES` (default `student,instructor`). Adding `admin` is not recommended.

## Settings

| Variable | Purpose | Default |
| --- | --- | --- |
| `LTI_PRIVATE_KEY` | The tool's RSA private key (PEM, `\n` allowed). From `npm run lti:keygen`. **Secret** | none: `/lti/jwks` is empty and `/lti/config.json` refuses |
| `LTI_TOOL_URL` | Public address of PlugLytics, used in the Canvas configuration and redirect URI | The address the request came in on |
| `LTI_CLIENT_ID` | Client ID of the Canvas developer key | none: launches refused |
| `LTI_DEPLOYMENT_IDS` | Allowed Canvas deployment IDs, comma-separated | none: launches refused |
| `LTI_ISSUER` | Canvas issuer | `https://canvas.instructure.com` (Instructure-hosted Canvas). Self-hosted: the school's Canvas address |
| `LTI_AUTH_URL` | Canvas's authorization endpoint | `https://sso.canvaslms.com/api/lti/authorize_redirect` |
| `LTI_JWKS_URL` | Canvas's public key set | `https://sso.canvaslms.com/api/lti/security/jwks` |
| `LTI_EMAIL_LINK_ROLES` | Roles linked by email on first launch | `student,instructor` |
| `FRAME_ANCESTORS` | Sites allowed to frame PlugLytics, space- or comma-separated `https://` origins | none: only PlugLytics itself |

The three Canvas URLs default to Instructure-hosted production Canvas. For Canvas's beta or test environments use `canvas.beta.instructure.com` / `sso.beta.canvaslms.com` or `canvas.test.instructure.com` / `sso.test.canvaslms.com`.

## Testing the launch

- **Automated:** `npm test` runs `tests/lti.test.js`, which acts as Canvas: it serves a test key set, signs launch tokens, and checks valid launches, replays, forged tokens, wrong audience, unknown deployments, role mismatches, admin linking, and framing headers.
- **In a real Canvas:** needs admin access, so use the pilot school's Canvas **test or beta** environment, or a self-hosted Canvas. Canvas Free-for-Teacher accounts cannot create LTI developer keys.

## Testing locally with a tunnel

Canvas needs a public HTTPS address for PlugLytics. For a test on a laptop, a free Cloudflare quick tunnel gives one without deploying:

1. Install it once: `brew install cloudflared` (macOS).
2. Create `.env` from `.env.example` and add a key with `npm run lti:keygen`.
3. In a separate terminal, run `cloudflared tunnel --url http://localhost:3000` and copy the `https://….trycloudflare.com` address it prints.
4. In `.env`, set `LTI_TOOL_URL` to that address, `FRAME_ANCESTORS=https://*.instructure.com` and `TRUST_PROXY=1`.
5. Run `npm run dev` and check `https://<tunnel>/lti/config.json`.
6. Follow steps 2–4 above with the tunnel address, then restart the server after setting `LTI_CLIENT_ID` and `LTI_DEPLOYMENT_IDS`.

The tunnel address changes every time `cloudflared` restarts. When it does, update `LTI_TOOL_URL` and the developer key's Redirect URI and URLs. Use a fresh `LTI_PRIVATE_KEY` for any real deployment; never reuse a test key.

## Tested in a real Canvas

| | |
| --- | --- |
| Date | Nov 22, 2026 |
| Canvas | Instructure-hosted (cloud), production environment, account admin |
| PlugLytics | Local server (`npm run dev`) behind a Cloudflare quick tunnel |
| Setup used | Developer key from `/lti/config.json`, installed through Canvas Apps, deployment set to Available |

Verified:

- The **PlugLytics** link appears in the Canvas account menu and opens the dashboard inside Canvas (`/accounts/<id>/external_tools/<tool id>`).
- The full launch: login initiation, Canvas authorization, signed `id_token`, signature, issuer, client ID, deployment, nonce and role checks.
- An unlinked Canvas admin sees the "not linked" page with their Canvas user ID; after `npm run lti:link`, the next launch opens the **Admin** workspace with no PlugLytics password.
- Framing works with `FRAME_ANCESTORS=https://*.instructure.com`.
- The dashboard shows the same figures as the API (for example tuition collected of 5,370,428, 83.7% of net billed).

Still to test in Canvas: the course tab as a teacher and a student, and a role mismatch (`LTI_ROLE_MISMATCH`).

## Known limits

- **Hosting:** account links and used nonces are stored in the PlugLytics database. On the Vercel demo, that database is a fresh copy on each new server instance, so hand-made admin links can disappear and are not reliable there. The pilot needs persistent storage (see [deployment.md](./deployment.md#3-production-database-strategy)).
- **Browser privacy settings:** the launch does not use cookies, because browsers often block them inside the Canvas frame. The dashboard keeps its sign-in in the browser's storage for the PlugLytics site; if a browser blocks that inside frames, the user can open PlugLytics in a new tab and sign in normally. Canvas's "LTI platform storage" is a possible later improvement.
- **Course filter:** the dashboard opens on the user's normal view, not filtered to the Canvas course yet.
- **No self-service linking yet:** users without a matching account see a "not linked" page. A planned "Link my account" page would let them sign in once with their PlugLytics password to link, and account provisioning (a Canvas importer or registrar CSV) would remove the step for most users.
- **App icon:** Canvas shows a broken image for the PlugLytics icon, because the server's `Cross-Origin-Resource-Policy: same-origin` header stops Canvas from loading it. Cosmetic only; fix by allowing cross-origin loading for the logo file.
- **Email trust:** automatic linking relies on Canvas emails. Ask the Canvas admin whether users can change their own email address; if they can, consider linking instructors by hand too (`LTI_EMAIL_LINK_ROLES=student`).

## Troubleshooting

| What the user sees | Likely cause |
| --- | --- |
| `LTI_NOT_CONFIGURED` | `LTI_CLIENT_ID` or `LTI_DEPLOYMENT_IDS` is not set |
| `LTI_UNKNOWN_ISSUER` | `LTI_ISSUER` does not match the Canvas (cloud vs self-hosted, or beta/test) |
| `LTI_UNKNOWN_CLIENT` | `LTI_CLIENT_ID` is not the key's Client ID |
| `LTI_UNKNOWN_DEPLOYMENT` | The Deployment ID is missing from `LTI_DEPLOYMENT_IDS` |
| `LTI_BAD_TOKEN` | Wrong `LTI_JWKS_URL` for this Canvas, or the server clock is wrong |
| `LTI_BAD_STATE` or `LTI_REPLAY` | The launch took longer than 10 minutes, or the page was refreshed. Open PlugLytics from Canvas again |
| `LTI_NOT_LINKED` | No PlugLytics account for this Canvas user (or an admin who has not been linked by hand) |
| `LTI_ROLE_MISMATCH` | The Canvas role differs from the PlugLytics account's role |
| A blank frame in Canvas | `FRAME_ANCESTORS` does not include the Canvas address |

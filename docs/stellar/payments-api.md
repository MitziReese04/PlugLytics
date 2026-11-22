# PlugLytics Stellar Payments API

> **Status: planned.** This document describes the payment API PlugLytics will expose. The endpoints below are **not implemented yet**. Today only the credential configuration exists (`src/stellarConfig.js` and `.env.example`). Field names and error codes may change during implementation.

## Contents

- [What is Stellar and why PlugLytics uses it](#what-is-stellar-and-why-pluglytics-uses-it)
- [Payment types](#payment-types)
- [Pricing fields](#pricing-fields)
- [From invoice to payment request](#from-invoice-to-payment-request)
- [The payment flow](#the-payment-flow)
- [Sandbox vs production](#sandbox-vs-production)
- [Payment policy settings](#payment-policy-settings)
- [API conventions](#api-conventions)
- [Endpoints](#endpoints)
- [How payments are detected and webhooks are sent](#how-payments-are-detected-and-webhooks-are-sent)
- [Error codes](#error-codes)
- [Testing with the testnet friendbot](#testing-with-the-testnet-friendbot)
- [Security rules](#security-rules)

## What is Stellar and why PlugLytics uses it

- **Stellar** is a public blockchain network built for sending money quickly and cheaply.
- Every Stellar **account** has two keys:
  - a **public key** that starts with `G` (safe to share; it works like an account number)
  - a **secret key** that starts with `S` (never share it; it works like a password that can move money)
- **Horizon** is the web API that lets programs read Stellar data, such as "which payments did this account receive?"
- PlugLytics uses Stellar so institutions can pay for PlugLytics directly, with low fees and fast settlement, and so every payment can be independently checked on the network.

## Payment types

PlugLytics supports two kinds of payment.

### Pay-per-use

- The customer pays once for a single item, such as one report export or one analytics run.
- One payment request equals one charge.
- Once the payment is completed, the item is unlocked.

### Seats / subscription

- An institution buys a number of **seats** (users) for a **billing period**, such as 50 seats for one month.
- PlugLytics creates a new payment request at the start of each period.
- Paying it activates (or renews) the subscription until the period ends.
- If a period's payment is not received before it expires, the subscription becomes `past_due`.

> Stellar does not "pull" money from a customer's account the way a card subscription does. Each renewal is a new payment that the customer sends.

## Pricing fields

Each invoice stores how its price is built, in the invoice's own currency. A payment request then converts the invoice's `finalAmount` into a Stellar asset (see [From invoice to payment request](#from-invoice-to-payment-request)).

| Field | Meaning | Rules |
| --- | --- | --- |
| `basePrice` | The price before anything is taken off or added (the invoice `amount`) | 0 or more |
| `currency` | The invoice currency, as an ISO 4217 code such as `USD` or `PHP`. All the money fields below are in this currency. | 3 capital letters. Default `USD`. |
| `scholarshipAmount` | Money taken off by a scholarship | 0 or more. Default `0`. |
| `scholarshipType` | Kind of scholarship: `merit`, `need_based`, `sponsored` or `other` | Required when `scholarshipAmount` is more than 0 |
| `scholarshipName` | The scholarship's name, for example `Academic Merit Scholarship` | Optional, up to 100 characters. Only allowed when `scholarshipAmount` is more than 0. |
| `discountPercent` | Discount, as a percent **of the base price** | 0 to 100. Default `0`. |
| `discountCode` | Code used for the discount, if any (for example `EARLY10`) | Optional, up to 50 characters |
| `platformFee` | PlugLytics platform fee added to the price | 0 or more. Default `0`. |
| `transactionFee` | PlugLytics's own payment processing fee, added to the price. It is **not** the Stellar network fee or an anchor fee (see below). | 0 or more. Default `0`. |
| `instructorCost` | What the school pays the instructor for this item | 0 or more. Default `0`. **Not** charged to the student. |
| `finalAmount` | What the student pays. **Computed**, never sent in a request. | Can never be below 0 |

How `finalAmount` is calculated:

```
finalAmount = basePrice
            - scholarshipAmount
            - (basePrice x discountPercent / 100)
            + platformFee
            + transactionFee
```

Example: base price 3000, merit scholarship 500, 10% discount (300), platform fee 25, transaction fee 1.50:

```
3000 - 500 - 300 + 25 + 1.50 = 2226.50
```

- The result is rounded to 2 decimal places.
- `instructorCost` does not change `finalAmount`. It is kept for cost and course-margin reports.
- Three kinds of fee can apply to a payment. Only the first is part of `finalAmount`:
  - **`transactionFee`**: PlugLytics's own processing fee. It is set on the invoice and included in `finalAmount`.
  - **Stellar network fee**: a tiny fee (in XLM) paid by **whoever sends** the transaction. The payer pays it on their payment, and PlugLytics pays it on refunds. It is never added to `finalAmount`.
  - **Anchor fees**: charged by an anchor or on-ramp when the payer converts local currency. The **payer** pays them to the anchor. They are never added to `finalAmount`, and the amount that reaches the merchant account must still match the payment request.
- A scholarship and discount that together are bigger than the base price plus fees are rejected (`VALIDATION_ERROR`), because `finalAmount` would be negative.
- The same rules are enforced in two places: the API (`src/pricing.js`) and the database (`CHECK` constraints on the `invoices` table in `src/schema.sql`).
- Admins set these fields with [`POST /api/v1/invoices` and `PATCH /api/v1/invoices/:id`](#post-apiv1invoices).

### Scholarships

- Scholarships are stored **on the invoice**, in the `scholarship_amount`, `scholarship_type` and `scholarship_name` columns (`scholarshipAmount`, `scholarshipType` and `scholarshipName` in the API). There is no separate scholarships table any more.
- `scholarship_name` (`scholarshipName`) is the scholarship's own name, for example `Academic Merit Scholarship`. It is only allowed when `scholarship_amount` is more than 0, and a type is then required too.
- **One scholarship per invoice.** Each invoice has one scholarship amount, one type and one name. If a student gets more than one scholarship for the same term, they cannot be stored as separate scholarships on one invoice.
- **Multiple scholarships per invoice is a group/school decision (TODO: group decision).** If the school awards more than one scholarship on the same invoice (for example merit plus sponsored), the plan is **Option B**: a separate `invoice_scholarships` table (`invoice_id`, `type`, `name`, `amount`), with `scholarship_amount` kept equal to their total by a database rule. Until that is decided, the one-scholarship-per-invoice rule applies.

## From invoice to payment request

Invoices are priced in a normal currency (for example `PHP` or `USD`), with 2 decimal places. Stellar payments are made in an asset (`XLM` or `USDC`), with 7 decimal places. When a payment request is created for an invoice, PlugLytics converts between the two.

### How the conversion works

1. **Pick the asset.** The request says which asset the payer will use, for example `USDC` (see [approved-payment-methods.md](./approved-payment-methods.md)).
2. **Get a quote.** PlugLytics gets an exchange rate for the invoice currency to that asset, from the rate source set by `PAYMENT_RATE_SOURCE` (only `manual` so far). The rate is written as **asset units per 1 unit of the invoice currency**. For example, if 1 PHP buys 0.0171 USDC, `quotedRate` is `"0.0171000"`.
3. **Convert.** `amount = balance due x quotedRate`, rounded **half up** to 7 decimal places. The balance due is the invoice's `finalAmount` minus payments already recorded for it, so a partly paid invoice is not charged twice. For an unpaid invoice it equals `finalAmount`.
4. **Check the limits.** The converted `amount` must be within the asset's minimum and maximum (`XLM_MIN_AMOUNT`, `XLM_MAX_AMOUNT` and so on), or the request is refused with `400 VALIDATION_ERROR`.
5. **Lock the rate.** The quoted rate is fixed until the request's `expiresAt`. Rate changes after that do not change what the payer owes. The database enforces this: once a request exists, its `amount`, `asset`, `assetIssuer`, `memo`, `destination`, `quotedRate`, `rateSource` and invoice fields cannot be changed (only its status can).
6. **Store it on the request.** The request saves `invoiceId`, `invoiceCurrency`, `invoiceAmount` (the balance due that was converted), `quotedRate`, `rateSource`, `rateQuotedAt`, `asset`, `assetIssuer` and the converted `amount`.

Example: an unpaid invoice with `finalAmount` 2226.50 PHP, paid in USDC at a quoted rate of 0.0171000:

```
2226.50 x 0.0171000 = 38.0731500 USDC
```

The request stores:

```json
{
  "invoiceId": 1042,
  "invoiceCurrency": "PHP",
  "invoiceAmount": "2226.50",
  "quotedRate": "0.0171000",
  "rateSource": "manual",
  "rateQuotedAt": "2026-11-21T12:00:00.000Z",
  "asset": "USDC",
  "assetIssuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "amount": "38.0731500",
  "expiresAt": "2026-11-21T12:30:00.000Z"
}
```

### Rules

- **Asset amounts are strings with exactly 7 decimal places**, for example `"38.0731500"`. Never use floating-point numbers for them.
- `quotedRate` is also a string, with up to 7 decimal places. `invoiceAmount` is a string with 2 decimal places.
- The conversion uses whole-number (integer) math, so there are no rounding errors. See `toAssetAmount()` in `src/pricing.js`.
- **The rate is locked only until `expiresAt`.** If the request expires, it becomes `failed` with reason `expired`. A new request for the same invoice gets a **new quote**, which may give a different asset amount.
- **Before quoting again,** PlugLytics checks any expired request for the invoice that is still `pending` (nobody has opened it since it expired) on Horizon. If it was paid before it expired, it becomes `completed` and no new request is made (`409 INVOICE_NOTHING_DUE`). If Horizon cannot be reached, no new request is made (`502 HORIZON_UNAVAILABLE`), so the student is never asked to pay twice.
- Matching on Horizon always uses the converted `amount` in the asset, never the invoice currency.
- The source of exchange-rate quotes is set by `PAYMENT_RATE_SOURCE` (only `manual` so far; **TODO: group decision**, see [Payment policy settings](#payment-policy-settings)). It is recorded with each quote as `rateSource`: `manual` for configured manual rates, or `manual-default-testnet` for the built-in test rates.
- To add a rate source later, add one function to `RATE_SOURCES` in `src/stellarQuotes.js`. Its name then becomes a valid `PAYMENT_RATE_SOURCE` value.
- Requests that are not created from an invoice (for example, a pay-per-use item priced directly in the asset) have `invoiceId`, `invoiceCurrency`, `invoiceAmount`, `quotedRate`, `rateSource` and `rateQuotedAt` set to `null`.

## The payment flow

Every payment, of either type, follows the same four steps.

```
1. Create payment request  ->  2. User pays  ->  3. Confirm on Horizon  ->  4. Mark completed
```

### 1. Create a payment request

- The client calls `POST /api/v1/payments`.
- PlugLytics saves a payment request with status `pending` and returns:
  - the **destination** (the merchant's public key)
  - the **amount** and **asset** (for example `25.0000000` `XLM`)
  - a unique **memo** (a short code that links the payment to this request)
  - an **expiry time**
  - a **payment URI** (`web+stellar:pay?...`) that wallets can open directly

### 2. The user pays

- The user opens their Stellar wallet and sends the exact amount to the destination **with the memo**.
- The memo is required. Without it, PlugLytics cannot tell which request the payment belongs to.

### 3. Confirm on Horizon

- PlugLytics asks Horizon for payments received by the merchant account.
- A payment **matches** a request only when all of these are true:
  - it was sent to the merchant's public key
  - the memo is the same as the request's memo
  - the asset is the same as the request's asset
  - the amount is equal to or more than the requested amount
  - the transaction succeeded and was made before the request expired
- PlugLytics watches Horizon for new payments in the background, and the client can also trigger the check with `POST /api/v1/payments/:id/confirm` (see [How payments are detected and webhooks are sent](#how-payments-are-detected-and-webhooks-are-sent)).

### 4. Mark completed

- The request's status changes from `pending` to `completed`, and the Stellar transaction hash is saved as proof.
- For pay-per-use, the item is unlocked. For a subscription, the seats are activated for the period.
- If the customer has set up a webhook URL, PlugLytics sends a signed `payment.completed` event to it (see [webhooks.md](./webhooks.md)).

### Payment statuses

| Status | Meaning |
| --- | --- |
| `pending` | Created and waiting for the user to pay |
| `completed` | A matching payment was found on Horizon |
| `failed` | The request can no longer be paid. The `reason` field says why (see below). |

When `status` is `failed`, the payment request also has a `reason`:

| Reason | Meaning |
| --- | --- |
| `expired` | No matching payment arrived before `expiresAt` |
| `cancelled` | Cancelled before payment |
| `underpaid` | A payment with the right memo arrived, but for less than the requested amount |
| `wrong_asset` | A payment with the right memo arrived, but in a different asset or from a different issuer |

### `failed` is final

- A `failed` payment request **never changes status again**. Nothing reopens it, and later payments with its memo do not complete it.
- Problems are fixed with a **new payment record** that points back to the failed one with `relatedPaymentId`:
  - **Underpaid:** PlugLytics creates a new `pending` request for the remaining amount (see [`POST /api/v1/payments`](#post-apiv1payments) with `relatedPaymentId`), or refunds the partial amount instead.
  - **Paid after expiry:** an admin creates a new `completed` record for the late transaction (see [`POST /api/v1/payments/:id/accept-late-payment`](#post-apiv1paymentsidaccept-late-payment)).
  - **Paid without a memo:** an admin matches the transaction by hand, which creates a new `completed` record (see [`POST /api/v1/payments/:id/match-transaction`](#post-apiv1paymentsidmatch-transaction)).
- Every payment record has a `relatedPaymentId` field. It is `null` unless the record follows up an earlier, failed request.

## Sandbox vs production

PlugLytics chooses the network with the `STELLAR_ENV` environment variable.

| `STELLAR_ENV` | Network | Horizon URL | Network passphrase | Real money? |
| --- | --- | --- | --- | --- |
| `sandbox` | Testnet | `https://horizon-testnet.stellar.org` | `Test SDF Network ; September 2015` | No |
| `production` | Public network (mainnet) | `https://horizon.stellar.org` | `Public Global Stellar Network ; September 2015` | **Yes** |

- `sandbox` reads the variables that start with `SANDBOX_`, and `production` reads the ones that start with `PRODUCTION_`.
- Each environment needs `MERCHANT_PUBLIC_KEY`, `MERCHANT_SECRET_KEY` and `WEBHOOK_SIGNING_SECRET` (with the matching prefix).
- `WEBHOOK_SIGNING_SECRET` is a **server-only key** that PlugLytics uses to encrypt the per-customer webhook secrets it stores. It is never used to sign webhooks directly and never given to customers (see [Webhook endpoints](#webhook-endpoints)).
- `STELLAR_HORIZON_URL` and `STELLAR_NETWORK_PASSPHRASE` are optional overrides. If they are empty, the defaults in the table above are used.
- `loadStellarConfig()` throws a clear error if `STELLAR_ENV` is not `sandbox` or `production`, or if a required value is missing or still a placeholder.

Setup:

1. Copy `.env.example` to `.env`.
2. Set `STELLAR_ENV=sandbox` while developing.
3. Fill in the `SANDBOX_` values (see [Testing with the testnet friendbot](#testing-with-the-testnet-friendbot)).
4. Switch to `STELLAR_ENV=production` and the `PRODUCTION_` values only when you deploy for real customers.

In code:

```js
const { loadStellarConfig } = require("./stellarConfig");

const stellar = loadStellarConfig();
// stellar.env, stellar.horizonUrl, stellar.networkPassphrase,
// stellar.merchantPublicKey, stellar.merchantSecretKey, stellar.webhookSigningSecret
```

## Payment policy settings

These settings live in `.env` (with placeholders in `.env.example`) and are loaded and checked by `src/paymentPolicy.js`. **Every value is a placeholder until the group decides it: TODO: group decision.**

| Setting | Meaning | Default | Used by |
| --- | --- | --- | --- |
| `PAYMENT_RATE_SOURCE` | Where exchange-rate quotes come from. Only `manual` exists so far. **TODO: group decision.** | `manual` | Creating payment requests |
| `PAYMENT_MANUAL_RATE_<CURRENCY>_<ASSET>` | Manual rate: asset units per 1 unit of the currency, up to 7 decimals (for example `PAYMENT_MANUAL_RATE_USD_XLM=2.5000000`). **TODO: group decision.** | If none is set: made-up testnet rates, 1 USD = 2.5 XLM and 1 PHP = 0.043 XLM | Creating payment requests |
| `XLM_MIN_AMOUNT`, `XLM_MAX_AMOUNT`, `USDC_MIN_AMOUNT`, `USDC_MAX_AMOUNT` | Smallest and largest amount of one payment request, in that asset. **TODO: group decision.** | Empty = no limit | Creating payment requests |
| `REFUND_WINDOW_DAYS` | Days after a payment during which a customer can ask for a refund (1 to 3650). **TODO: group decision.** | Empty = not decided; refunds must not run | Refunds (not built yet) |
| `REFUND_APPROVAL_THRESHOLD_XLM`, `REFUND_APPROVAL_THRESHOLD_USDC` | Refunds above this amount (in that asset) need a second admin. **TODO: group decision.** | Empty = not decided | Refunds (not built yet) |
| `APPROVED_ANCHORS` | Comma-separated anchor home domains, for example `anchor.example.com`. **TODO: group decision.** | Empty = no anchors approved | Anchor payments (not built yet) |

Rules:

- If **any** `PAYMENT_MANUAL_RATE_` setting is set, only the configured rates are used. The built-in test rates are not mixed in.
- Amounts, rates and thresholds are compared in stroops (whole numbers), never as decimals.
- If any setting is invalid, creating a payment request returns `503 PAYMENT_POLICY_INVALID`, and `details.problems` names every invalid setting. The settings hold no secrets, so naming them is safe.
- The settings are read on each request, so a server restart picks up changes in `.env`.

## API conventions

The payment endpoints follow the same rules as the rest of the PlugLytics API.

- **Base path:** `/api/v1/payments` (and `/api/v1/subscriptions`, `/api/v1/webhooks`)
- **Authentication:** every payment endpoint needs one of these:
  - **Admin login:** `Authorization: Bearer <JWT>` (get a token from `POST /api/v1/auth/login`). Can use every endpoint.
  - **Customer API key:** `X-PlugLytics-Api-Key: plk_...`. **Read-only**, and limited to the school the key belongs to (see [Customer API keys](#customer-api-keys)).
- **Amounts** are strings with up to 7 decimal places (for example `"25.0000000"`), because Stellar uses 7 decimal places and strings avoid rounding errors.
- **Times** are ISO 8601 UTC strings.
- **Response envelope:** every response has `data`, `meta` and `error`.

Success:

```json
{
  "data": { "...": "..." },
  "meta": { "filtersApplied": {}, "generatedAt": "2026-11-21T12:00:00.000Z", "page": 1, "total": 0 },
  "error": null
}
```

Error:

```json
{
  "data": null,
  "meta": { "filtersApplied": {}, "generatedAt": "2026-11-21T12:00:00.000Z", "page": 1, "total": 0 },
  "error": { "code": "VALIDATION_ERROR", "message": "amount must be greater than 0", "details": null }
}
```

To keep the examples below short, only the `data` part is shown for success responses. The full response always uses the envelope above.

## Endpoints

| Method | Path | Who can call it | What it does |
| --- | --- | --- | --- |
| GET | `/api/v1/payments/config` | Any signed-in user | Show the active network and merchant public key |
| POST | `/api/v1/api-keys` | Admin (**built**) | Create a customer API key for a school (the key is shown once) |
| GET | `/api/v1/api-keys` | Admin (**built**) | List customer API keys (never the key itself) |
| DELETE | `/api/v1/api-keys/:id` | Admin (**built**) | Revoke a customer API key |
| GET | `/api/v1/api-keys/schools` | Admin (**built**) | List schools, to choose which school a key is for |
| GET | `/api/v1/invoices` | Admin (**built**) | List invoices, filtered by student number and term, with whether each can still be edited |
| GET | `/api/v1/invoices/:id` | Admin (**built**) | Get one invoice |
| GET | `/api/v1/invoices/options` | Admin (**built**) | Terms (with IDs) and scholarship types, for the invoice form |
| GET | `/api/v1/invoices/students?number=` | Admin (**built**) | Find a student by student number, for example `STU-0001` |
| POST | `/api/v1/invoices` | Admin (**built**) | Create an invoice with pricing fields |
| PATCH | `/api/v1/invoices/:id` | Admin (**built**) | Change an invoice's pricing fields or due date (blocked once a payment is completed) |
| POST | `/api/v1/payments` | Student (own invoice, **built, sandbox only**); Admin (pay-per-use, planned) | Create a payment request |
| GET | `/api/v1/payments` | Admin (**built**), or customer API key (own school, read-only, planned) | List payment requests |
| GET | `/api/v1/payments/invoices` | Student (**built**) | List your own invoices with what is still due and the latest Stellar payment request |
| GET | `/api/v1/payments/:id` | Student (own invoice, **built**), Admin (**built**), or customer API key (own school, read-only, planned) | Get one payment request, checking Horizon first while it is pending |
| POST | `/api/v1/payments/:id/confirm` | Admin | Check Horizon now and mark the payment completed if a match is found |
| POST | `/api/v1/payments/:id/cancel` | Student (own invoice, **built**), Admin (**built**) | Cancel a pending request |
| POST | `/api/v1/payments/:id/accept-late-payment` | Admin | Record a payment that arrived after expiry as a new `completed` payment |
| POST | `/api/v1/payments/:id/match-transaction` | Admin | Record a payment that arrived without a memo as a new `completed` payment |
| POST | `/api/v1/subscriptions` | Admin | Create a seat subscription and its first payment request |
| GET | `/api/v1/subscriptions/:id` | Admin, or customer API key (own school, read-only) | Get a subscription and its current period |
| POST | `/api/v1/webhooks` | Admin (**built**) | Register a school's webhook URL and get its signing secret (shown once) |
| GET | `/api/v1/webhooks` | Admin (**built**) | List registered webhook URLs |
| DELETE | `/api/v1/webhooks/:id` | Admin (**built**) | Remove a webhook URL |
| POST | `/api/v1/webhooks/:id/rotate-secret` | Admin (**built**) | Replace the signing secret (new secret shown once) |
| GET | `/api/v1/webhooks/events` | Admin (**built**) | List the events an endpoint can subscribe to |

### Customer API keys

**Built.** Schools (customers) can read their own payments without an admin login, for example to catch up after their webhook server was down.

- Send the key in the header `X-PlugLytics-Api-Key: plk_...`.
- A key is **read-only**. It works only on:
  - `GET /api/v1/payments`
  - `GET /api/v1/payments/:id`
  - `GET /api/v1/subscriptions/:id`
- A key is **scoped to one school**. It only sees that school's payment requests and subscriptions:
  - `GET /api/v1/payments` lists only that school's requests.
  - Asking for another school's ID returns `404` (`PAYMENT_NOT_FOUND` or `SUBSCRIPTION_NOT_FOUND`), so a key cannot even tell that the record exists.
- Using a key on any other endpoint (creating, cancelling or confirming payments, managing webhooks) returns `403` `API_KEY_READ_ONLY`.
- A PlugLytics admin creates the key for a school. It is shown **once**, and PlugLytics stores only a hash of it (it only needs to check the key, never to read it back).
- Keep the key on your server, in `.env` (for example `PLUGLYTICS_API_KEY`). Never put it in a browser or mobile app.
- An invalid, badly formatted or revoked key returns `401 AUTH_INVALID`. `GET /api/v1/payments/:id` still checks Horizon for a pending request, as it does for admins.
- `GET /api/v1/subscriptions/:id` is allowed for keys, but subscriptions are not built yet.

**How keys are stored:**

- A key is `plk_` followed by 43 random characters (32 random bytes).
- PlugLytics stores only its **SHA-256 hash**, plus the first 12 characters (`keyPrefix`, for example `plk_Xy3k9Qa1`) so admins can tell keys apart. A fast hash is safe here because keys are long and random, unlike passwords.
- Each use records `lastUsedAt`.

**Schools:** each student belongs to a school (`students.school_id`), and a key sees a payment request through its invoice → student → school. The demo data has one placeholder school, `Demo School (placeholder)` (code `DEMO`), with every demo student in it. The real school name and code are **TODO: group decision**.

#### POST `/api/v1/api-keys`

**Admin only.** Request: `{ "schoolId": 1, "name": "Finance office" }` (`name` is a label, up to 100 characters).

Response `201` (`data`):

```json
{
  "id": "key_7K2M9QX4R8T1VW3N",
  "schoolId": 1,
  "schoolName": "Demo School (placeholder)",
  "name": "Finance office",
  "keyPrefix": "plk_EXAMPLE1",
  "status": "active",
  "createdAt": "2026-11-22T09:00:00.000Z",
  "lastUsedAt": null,
  "revokedAt": null,
  "key": "plk_EXAMPLE..."
}
```

- **`key` is shown only in this response.** Copy it now. It cannot be shown again; if it is lost, revoke it and create a new one.
- Errors: `400 VALIDATION_ERROR`, `404 SCHOOL_NOT_FOUND`.

#### GET `/api/v1/api-keys`

**Admin only.** Lists keys, newest first, optionally `?schoolId=1`. Same fields as above, **without** `key`. The hash is never returned.

#### DELETE `/api/v1/api-keys/:id`

**Admin only.** Revokes a key. It stops working at once (`401 AUTH_INVALID`) and cannot be turned back on. Response `200` has the key with `"status": "revoked"` and `revokedAt`. Errors: `404 API_KEY_NOT_FOUND`, `409 API_KEY_ALREADY_REVOKED`.

#### GET `/api/v1/api-keys/schools`

**Admin only.** Lists schools (`id`, `name`, `code`).

### GET `/api/v1/payments/config`

Returns public information only. Secret keys are **never** returned.

Response `200` (`data`):

```json
{
  "environment": "sandbox",
  "horizonUrl": "https://horizon-testnet.stellar.org",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "merchantPublicKey": "GABC...XYZ",
  "supportedAssets": [
    { "asset": "XLM", "assetIssuer": null },
    { "asset": "USDC", "assetIssuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" }
  ]
}
```

- Each asset is a code **plus** its issuer. `assetIssuer` is `null` for XLM, which is Stellar's native asset and has no issuer.
- USDC uses Circle's issuer for the current network: the testnet issuer above in sandbox, and `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` in production (see [settlement.md](./settlement.md#which-assets-we-accept)).
- XLM is approved and the default asset for sandbox and the pilot. USDC is approved and the planned default for production, because of its stable dollar value. USDC appears in this list only once it is enabled on the server.

### POST `/api/v1/invoices`

**Built. Admin only.** Creates an invoice with the [pricing fields](#pricing-fields). PlugLytics works out `finalAmount` with `computeFinalAmount()` in `src/pricing.js` (the database computes the same value).

Request:

```json
{
  "studentId": 42,
  "termId": 4,
  "basePrice": 3000,
  "currency": "PHP",
  "scholarshipAmount": 500,
  "scholarshipType": "merit",
  "scholarshipName": "Academic Merit Scholarship",
  "discountPercent": 10,
  "discountCode": "EARLY10",
  "platformFee": 25,
  "transactionFee": 1.5,
  "instructorCost": 800,
  "dueAt": "2026-12-15T23:59:00Z"
}
```

- `studentId`, `termId`, `basePrice` and `dueAt` are required. `issuedAt` is optional and defaults to now. `dueAt` cannot be before `issuedAt`.
- Every pricing field follows the rules in [Pricing fields](#pricing-fields), and the same defaults apply (`USD`, and `0` or `null` for everything else).
- `finalAmount` is never sent: it is always computed. Unknown fields are rejected.

Response `201` (`data`):

```json
{
  "id": 2002,
  "studentId": 42,
  "termId": 4,
  "currency": "PHP",
  "basePrice": 3000,
  "scholarshipAmount": 500,
  "scholarshipType": "merit",
  "scholarshipName": "Academic Merit Scholarship",
  "discountPercent": 10,
  "discountCode": "EARLY10",
  "platformFee": 25,
  "transactionFee": 1.5,
  "instructorCost": 800,
  "finalAmount": 2226.5,
  "issuedAt": "2026-11-22T09:00:00.000Z",
  "dueAt": "2026-12-15T23:59:00Z"
}
```

Errors: `400 VALIDATION_ERROR` (for example a negative amount, a discount over 100, a scholarship without a type, or a final amount below 0), `404 STUDENT_NOT_FOUND`, `404 TERM_NOT_FOUND`.

### Reading invoices (admin)

**Built. Admin only.** Used by the admin dashboard's **Invoices** screen.

- `GET /api/v1/invoices`: newest first, 25 per page. Optional filters: `student` (a student number, any letter case), `termId` and `page`. Each item has the same fields as `POST /api/v1/invoices` returns, plus `studentNumber`, `studentName`, `termName`, `editable` and `lockReason`.
- `GET /api/v1/invoices/:id`: one invoice, in the same shape.
- `editable` is `false` when `PATCH` would be refused. `lockReason` says why: `completed_payment` (a completed or recorded payment) or `pending_payment_request` (a pending request with a locked quote). Otherwise it is `null`.
- `GET /api/v1/invoices/options`: every term (`id`, `name`, `code`, `isCurrent`) and the scholarship types.
- `GET /api/v1/invoices/students?number=STU-0001`: finds a student (`id`, `studentNumber`, `name`), or `404 STUDENT_NOT_FOUND`.
- The dashboard previews `finalAmount` while you type with `public/pricingPreview.js`, which uses the same formula as `src/pricing.js` (a test keeps the two in step). The server still checks and saves the real value.

### PATCH `/api/v1/invoices/:id`

**Built. Admin only.** Changes an invoice's pricing fields (`basePrice`, `currency`, `scholarshipAmount`, `scholarshipType`, `scholarshipName`, `discountPercent`, `discountCode`, `platformFee`, `transactionFee`, `instructorCost`) or its `dueAt`. Send only the fields to change.

Request:

```json
{ "platformFee": 50, "dueAt": "2026-12-31T23:59:00Z" }
```

- The changed fields are combined with the invoice's current ones, and **the result** must pass the pricing rules. For example, a new discount that would push `finalAmount` below 0 is rejected.
- `finalAmount` is recomputed. The response has the same shape as `POST /api/v1/invoices`.
- Setting `scholarshipAmount` to `0` also clears `scholarshipType` and `scholarshipName`, unless they are sent in the same request.
- `studentId`, `termId`, `issuedAt` and `finalAmount` cannot be changed (`400 VALIDATION_ERROR`).
- **Blocked once money has been received:** if the invoice has a `completed` Stellar payment request, or any payment already recorded for it, the change is refused with `409 INVOICE_HAS_COMPLETED_PAYMENT`. Fix a wrong price with a refund or a follow-up request instead.
- **Blocked while a payment request is pending:** its quote is locked for the current price (see [From invoice to payment request](#from-invoice-to-payment-request)), so the change is refused with `409 PAYMENT_ALREADY_PENDING` (`details.paymentId` is the pending request). Change the invoice after that request expires or fails.

Errors: `400 VALIDATION_ERROR`, `404 INVOICE_NOT_FOUND`, `409 INVOICE_HAS_COMPLETED_PAYMENT`, `409 PAYMENT_ALREADY_PENDING`.

### POST `/api/v1/payments`

This endpoint has two uses:

- **Student paying their own invoice** (built, sandbox/testnet only). See [Student invoice payments](#student-invoice-payments-sandbox) below.
- **Admin creating a pay-per-use request** (planned, not built yet). The rest of this section describes it.

#### Student invoice payments (sandbox)

A signed-in **student** creates a payment request for one of **their own** invoices that still has something to pay.

Request:

```json
{ "invoiceId": 1042, "asset": "XLM" }
```

- `invoiceId`: required. Must be the student's own invoice. Another student's invoice gets the same `404` as a missing one, so its existence is not revealed.
- `asset`: optional, defaults to `XLM`. Only `XLM` is enabled so far.

What PlugLytics does:

- Uses the **sandbox** (testnet) settings from `src/stellarConfig.js`. If `STELLAR_ENV` is not `sandbox`, or a sandbox credential is missing, it returns `503 STELLAR_NOT_CONFIGURED`.
- Charges the invoice's **outstanding balance**: `finalAmount` minus payments already recorded for it.
- Converts it to XLM with a **sandbox quote** from the manual rates in the [payment policy](#payment-policy-settings) (`PAYMENT_MANUAL_RATE_<CURRENCY>_<ASSET>`). If none are set, fixed, made-up test rates are used, because testnet XLM has no value. Real quotes are still **TODO: group decision**.
- Refuses amounts outside the asset's minimum and maximum (`XLM_MIN_AMOUNT` and `XLM_MAX_AMOUNT`) with `400 VALIDATION_ERROR`.
- Creates a unique ID (`pay_` + 16 characters) and a unique memo (`PL-` + 8 characters).
- Sets `expiresAt` to **30 minutes** after creation. The quoted rate is locked until then.

Response `201` (`data`):

```json
{
  "id": "pay_7K2M9QX4R8T1VW3N",
  "type": "invoice",
  "status": "pending",
  "invoiceId": 1042,
  "invoiceCurrency": "USD",
  "invoiceAmount": "100.00",
  "quotedRate": "2.5000000",
  "rateSource": "manual-default-testnet",
  "rateQuotedAt": "2026-11-22T09:00:00.000Z",
  "amount": "250.0000000",
  "asset": "XLM",
  "assetIssuer": null,
  "destination": "GABC...XYZ",
  "memo": "PL-4QH7ZK2M",
  "memoType": "text",
  "paymentUri": "web+stellar:pay?destination=GABC...XYZ&amount=250.0000000&memo=PL-4QH7ZK2M&memo_type=MEMO_TEXT",
  "network": "sandbox",
  "createdAt": "2026-11-22T09:00:00.000Z",
  "expiresAt": "2026-11-22T09:30:00.000Z",
  "paidAt": null,
  "transactionHash": null,
  "relatedPaymentId": null
}
```

Errors specific to this use:

- `404 INVOICE_NOT_FOUND`: no such invoice for this student
- `409 INVOICE_NOTHING_DUE`: the invoice is fully paid, or already has a `completed` Stellar payment
- `409 PAYMENT_ALREADY_PENDING`: a request for this invoice is still `pending` and not expired (`details.paymentId` is its ID)
- `422 RATE_UNAVAILABLE`: no manual rate for the invoice currency and asset (by default only `USD` and `PHP` to `XLM`)
- `400 VALIDATION_ERROR`: the converted amount is below the asset's minimum or above its maximum (`details` has `amount`, `min` and `max`)
- `503 PAYMENT_POLICY_INVALID`: a payment policy setting is invalid (`details.problems` names each one)
- `400 UNSUPPORTED_ASSET`, `400 VALIDATION_ERROR`, `503 STELLAR_NOT_CONFIGURED`
- Admins and instructors get `403 FORBIDDEN` until the pay-per-use use is built.

#### Admin pay-per-use requests (planned)

Creates a pay-per-use payment request.

Request:

```json
{
  "type": "pay_per_use",
  "description": "Course analytics export - CS101, Fall term",
  "amount": "25.0000000",
  "asset": "XLM",
  "assetIssuer": null,
  "reference": "export-cs101-fall"
}
```

- `type`: required, must be `pay_per_use`
- `description`: required, 1-200 characters
- `amount`: the amount in the asset, greater than 0, up to 7 decimal places. Required unless `invoiceId` is sent.
- `invoiceId`: optional. Send it instead of `amount` to charge an invoice: PlugLytics converts the invoice's `finalAmount` into the asset and locks the rate (see [From invoice to payment request](#from-invoice-to-payment-request)). Send `amount` or `invoiceId`, not both.
- `asset`: optional. Defaults to `XLM` in sandbox and the pilot. `USDC` is the planned default for production.
- `assetIssuer`: optional. Must be `null` (or left out) for `XLM`. For `USDC`, you can leave it out and PlugLytics fills in Circle's issuer for the current network. If you send it, it must match an entry in `supportedAssets`.
- `reference`: optional, your own ID for this charge (also used to stop duplicate requests)
- `relatedPaymentId`: optional, the ID of a `failed` payment request that this new request follows up. Use it to ask for the remaining amount after an underpayment. The related request stays `failed`.

Follow-up example: request `pay_01JDC2H6UV` asked for 25 XLM, only 20 XLM arrived, so it is `failed` with reason `underpaid`. A new request asks for the remaining 5 XLM:

```json
{
  "type": "pay_per_use",
  "description": "Remaining amount for CS101 analytics export",
  "amount": "5.0000000",
  "asset": "XLM",
  "assetIssuer": null,
  "relatedPaymentId": "pay_01JDC2H6UV"
}
```

The response is a normal `pending` payment request with its own new memo and `"relatedPaymentId": "pay_01JDC2H6UV"`.

Response `201` (`data`):

```json
{
  "id": "pay_01JD8Z6Q4K",
  "type": "pay_per_use",
  "status": "pending",
  "description": "Course analytics export - CS101, Fall term",
  "amount": "25.0000000",
  "asset": "XLM",
  "assetIssuer": null,
  "destination": "GABC...XYZ",
  "memo": "PL-7F3K9Q",
  "memoType": "text",
  "paymentUri": "web+stellar:pay?destination=GABC...XYZ&amount=25.0000000&memo=PL-7F3K9Q&memo_type=MEMO_TEXT",
  "network": "sandbox",
  "invoiceId": null,
  "invoiceCurrency": null,
  "invoiceAmount": null,
  "quotedRate": null,
  "rateQuotedAt": null,
  "createdAt": "2026-11-21T12:00:00.000Z",
  "expiresAt": "2026-11-21T12:30:00.000Z",
  "paidAt": null,
  "transactionHash": null,
  "relatedPaymentId": null
}
```

#### USDC example

The same request in USDC (sandbox). Leaving out `assetIssuer` would give the same result, because PlugLytics fills in Circle's issuer.

Request:

```json
{
  "type": "pay_per_use",
  "description": "Course analytics export - CS101, Fall term",
  "amount": "25.0000000",
  "asset": "USDC",
  "assetIssuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "reference": "export-cs101-fall-usdc"
}
```

Response `201` (`data`):

```json
{
  "id": "pay_01JDB4N2RS",
  "type": "pay_per_use",
  "status": "pending",
  "description": "Course analytics export - CS101, Fall term",
  "amount": "25.0000000",
  "asset": "USDC",
  "assetIssuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "destination": "GABC...XYZ",
  "memo": "PL-K4V8TZ",
  "memoType": "text",
  "paymentUri": "web+stellar:pay?destination=GABC...XYZ&amount=25.0000000&asset_code=USDC&asset_issuer=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5&memo=PL-K4V8TZ&memo_type=MEMO_TEXT",
  "network": "sandbox",
  "invoiceId": null,
  "invoiceCurrency": null,
  "invoiceAmount": null,
  "quotedRate": null,
  "rateQuotedAt": null,
  "createdAt": "2026-11-21T12:00:00.000Z",
  "expiresAt": "2026-11-21T12:30:00.000Z",
  "paidAt": null,
  "transactionHash": null,
  "relatedPaymentId": null
}
```

- The `paymentUri` includes `asset_code` and `asset_issuer`, so the wallet sends the right USDC.
- The merchant account needs a USDC trustline first (see [settlement.md](./settlement.md#which-assets-we-accept)). A USDC payment from any other issuer is `failed` with reason `wrong_asset`.
- In production, `assetIssuer` would be `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`.

### GET `/api/v1/payments`

Lists payment requests, newest first. **Built for admins** (students and instructors get `403`). Used by the admin dashboard's Stellar Payments view.

Query parameters (all optional):

- `status`: `pending`, `completed` or `failed`
- `reason`: only used with `status=failed`. One of `expired`, `cancelled`, `underpaid` or `wrong_asset` (for example `?status=failed&reason=expired`)
- `type`: `pay_per_use` or `subscription` (planned, not built yet)
- `page`: page number, starting at 1. Each page has up to 25 requests.

Response `200`: `data` is an array of payment request objects (the same shape as above), and `meta.total` is the number of matching requests, with `meta.page` and `meta.pageSize`. Unknown or invalid filters return `400 VALIDATION_ERROR`.

The list shows statuses **as stored**. It does not ask Horizon, so a request can show `pending` until someone opens it with `GET /api/v1/payments/:id`.

### GET `/api/v1/payments/:id`

Returns one payment request in the same shape as the create response. **Built** for students (their own invoices only; anything else returns `404 PAYMENT_NOT_FOUND`) and admins.

While the request is `pending`, PlugLytics first checks Horizon (sandbox/testnet) for a payment to the merchant account with the request's memo, and updates the request before returning it:

| What Horizon shows (before `expiresAt`) | New status | `reason` |
| --- | --- | --- |
| Right asset and issuer, at least the amount | `completed` | none |
| Right asset and issuer, less than the amount | `failed` | `underpaid` |
| Different asset or issuer | `failed` | `wrong_asset` |
| Nothing usable, and `expiresAt` has passed | `failed` | `expired` |
| Nothing yet, and not expired | stays `pending` | none |

- Only successful transactions to the merchant account with a **text** memo equal to the request's memo count. Amounts are compared in stroops (whole numbers), never as decimals.
- A payment that arrives **after** `expiresAt` does not complete the request. It becomes `failed` with reason `expired`, and an admin can accept the late payment with `accept-late-payment`.
- `completed` and `failed` are final. Once a request is final, it is returned as stored and Horizon is not asked again.
- For `completed`, `underpaid` and `wrong_asset`, the response includes `transactionHash`, `amountReceived` and `ledger`. `paidAt` is set only for `completed`.
- Errors: `404 PAYMENT_NOT_FOUND`, `409 TRANSACTION_ALREADY_LINKED` (the matching transaction belongs to another request), `502 HORIZON_UNAVAILABLE` (the request stays `pending`; try again), `503 STELLAR_NOT_CONFIGURED` (a pending request needs the sandbox settings to be checked).
- Horizon is read with plain HTTP requests (`src/stellarHorizon.js`), not the Stellar SDK.
- If Horizon answers `404` for the merchant account (an account that has never been funded does not exist on the network yet), that counts as "no payments yet", not as an error.

### GET `/api/v1/payments/invoices`

**Built.** Lists the signed-in student's own invoices, newest term first. Used by the student dashboard's Payments section.

Each item has `id`, `term`, `termCode`, `currency`, `finalAmount`, `recordedPayments`, `outstanding` (2-decimal strings), `dueAt`, `status` and `latestPaymentRequest`:

- `status` is `due` (nothing paid yet), `partial` (some paid) or `settled` (nothing left to pay). An invoice with a `completed` Stellar payment request counts as `settled`.
- `latestPaymentRequest` is the newest payment request for the invoice (`id`, `status`, `reason`, `amount`, `asset`, `expiresAt`, `paidAt`), or `null`. The dashboard uses it to reopen a request that is still `pending`.
- Students only (`403` for admins and instructors).

### POST `/api/v1/payments/:id/confirm`

Asks Horizon right away whether a matching payment has arrived. Calling it more than once is safe.

Request body: none.

Response `200` when completed (`data`):

```json
{
  "id": "pay_01JD8Z6Q4K",
  "status": "completed",
  "amount": "25.0000000",
  "amountReceived": "25.0000000",
  "asset": "XLM",
  "assetIssuer": null,
  "paidAt": "2026-11-21T12:04:31.000Z",
  "transactionHash": "3389e9f0f1a65f19736cacf544c2e825313e8447f569233bb8db39aa607c8889",
  "ledger": 1234567,
  "relatedPaymentId": null
}
```

Response `200` when nothing has arrived yet: the same shape with `"status": "pending"` and `paidAt` / `transactionHash` set to `null`. Try again in a few seconds.

### POST `/api/v1/payments/:id/cancel`

**Built.** Cancels a `pending` request. Students can cancel requests for their own invoices (the dashboard has a **Cancel payment request** button); admins can cancel any. Payments sent after cancelling are not matched. Response `200` contains the request with `"status": "failed"` and `"reason": "cancelled"`.

- **Horizon is checked first.** If a matching payment has already arrived, the request becomes `completed` instead and the cancel is refused with `409 PAYMENT_ALREADY_COMPLETED` (`details` has `paymentId` and `transactionHash`). If the request has expired, it becomes `failed` with reason `expired` and the cancel is refused with `409 PAYMENT_NOT_PENDING`.
- Only `pending` requests can be cancelled: a `completed` request gives `409 PAYMENT_ALREADY_COMPLETED`, and a `failed` one gives `409 PAYMENT_NOT_PENDING`.
- If Horizon cannot be reached, nothing is cancelled (`502 HORIZON_UNAVAILABLE`). Without the sandbox settings it returns `503 STELLAR_NOT_CONFIGURED`.
- Another student's request looks the same as a missing one (`404 PAYMENT_NOT_FOUND`). Instructors get `403`.
- After cancelling, the student can create a new request for the invoice (with a new quote).

### POST `/api/v1/payments/:id/accept-late-payment`

Use this when a correct payment arrived **after** `expiresAt`, and an admin has decided to accept it instead of refunding it.

- `:id` is the expired request. It **stays** `failed` with reason `expired`.
- PlugLytics creates a **new** payment record with status `completed` and `relatedPaymentId` set to `:id`.
- It sends `payment.completed` for the **new** record (and `subscription.activated` if it is a subscription payment).

Request:

```json
{
  "transactionHash": "9b1e5d3a7c2f8e4b0a6d1c9f5e3b7a2d8c4f0e6b1a9d5c3f7e2b8a4d0c6f1e9b",
  "note": "Customer paid 2 hours late; accepted by finance"
}
```

- `transactionHash`: required, the late Stellar transaction
- `note`: required, why the late payment was accepted (saved for audits)

Before creating the record, PlugLytics checks the transaction on Horizon:

- it succeeded and was sent to the merchant account
- its memo, asset, issuer and amount match the expired request
- it is not already linked to another payment record

Response `201` (`data`):

```json
{
  "id": "pay_01JDC7W3XY",
  "type": "pay_per_use",
  "status": "completed",
  "amount": "25.0000000",
  "amountReceived": "25.0000000",
  "asset": "XLM",
  "assetIssuer": null,
  "paidAt": "2026-11-21T14:31:07.000Z",
  "transactionHash": "9b1e5d3a7c2f8e4b0a6d1c9f5e3b7a2d8c4f0e6b1a9d5c3f7e2b8a4d0c6f1e9b",
  "ledger": 1236012,
  "relatedPaymentId": "pay_01JDC5T8LM",
  "note": "Customer paid 2 hours late; accepted by finance",
  "acceptedBy": "admin@pluglytics.local"
}
```

### POST `/api/v1/payments/:id/match-transaction`

Use this when a payment arrived **without a memo** (or with a memo that matches no request), and an admin has found which payment request it was meant for, using the sender's account, the amount and the time.

- `:id` is the payment request the money was meant for. It **stays as it was**: this endpoint never changes its status.
- That request must already be `failed` (usually `expired`, or `cancelled`). If it is still `pending`, cancel it first with `POST /api/v1/payments/:id/cancel`. Otherwise a later payment with its memo could complete it, and the same charge would be paid twice.
- PlugLytics creates a **new** payment record with status `completed` and `relatedPaymentId` set to `:id`.
- It sends `payment.completed` for the **new** record (and `subscription.activated` if it is a subscription payment).

Request:

```json
{
  "transactionHash": "4d8a2c6e0b9f7a3d5c1e8b6a4f2d0c9e7b5a3f1d8c6e4a2b0f9d7c5e3a1b8f6d",
  "note": "Sent without a memo; matched by sender account and amount, confirmed by the school"
}
```

- `transactionHash`: required, the Stellar transaction that arrived without a memo
- `note`: required, how the transaction was matched to this request (saved for audits)

Before creating the record, PlugLytics checks the transaction on Horizon:

- it succeeded and was sent to the merchant account (correct destination)
- its asset and issuer are the same as the request's `asset` and `assetIssuer`
- its amount is equal to or more than the request's amount
- it has no memo, or a memo that matches no payment request
- it is not already linked to another payment record (not already used)

Response `201` (`data`):

```json
{
  "id": "pay_01JDE9M4NP",
  "type": "pay_per_use",
  "status": "completed",
  "amount": "25.0000000",
  "amountReceived": "25.0000000",
  "asset": "XLM",
  "assetIssuer": null,
  "paidAt": "2026-11-21T12:20:44.000Z",
  "transactionHash": "4d8a2c6e0b9f7a3d5c1e8b6a4f2d0c9e7b5a3f1d8c6e4a2b0f9d7c5e3a1b8f6d",
  "ledger": 1235210,
  "relatedPaymentId": "pay_01JDE2F5GH",
  "note": "Sent without a memo; matched by sender account and amount, confirmed by the school",
  "acceptedBy": "admin@pluglytics.local"
}
```

### POST `/api/v1/subscriptions`

Creates a seat subscription and the payment request for its first period.

Request:

```json
{
  "plan": "institution_monthly",
  "seats": 50,
  "pricePerSeat": "2.0000000",
  "asset": "XLM",
  "assetIssuer": null,
  "period": "monthly"
}
```

- `seats`: required, whole number of at least 1
- `pricePerSeat`: required, greater than 0
- `period`: `monthly` or `yearly`

Response `201` (`data`):

```json
{
  "id": "sub_01JD8ZB2MP",
  "plan": "institution_monthly",
  "status": "pending",
  "seats": 50,
  "period": "monthly",
  "currentPeriodStart": null,
  "currentPeriodEnd": null,
  "payment": {
    "id": "pay_01JD8ZB2MQ",
    "type": "subscription",
    "status": "pending",
    "amount": "100.0000000",
    "asset": "XLM",
    "assetIssuer": null,
    "destination": "GABC...XYZ",
    "memo": "PL-Q2M8XA",
    "memoType": "text",
    "paymentUri": "web+stellar:pay?destination=GABC...XYZ&amount=100.0000000&memo=PL-Q2M8XA&memo_type=MEMO_TEXT",
    "expiresAt": "2026-11-28T12:00:00.000Z"
  }
}
```

- The amount is `seats x pricePerSeat` (here 50 x 2 = 100).
- When the payment is completed, the subscription becomes `active` and `currentPeriodStart` / `currentPeriodEnd` are filled in.
- Subscription statuses: `pending`, `active`, `past_due`, `cancelled`.

### GET `/api/v1/subscriptions/:id`

Returns the subscription, its current period and its latest payment request, in the same shape as the create response.

### Webhook endpoints

**Built.** An admin registers each customer's (school's) webhook URL, and **every registered URL gets its own signing secret**. No secret is ever shared between customers. The admin dashboard has a **Webhooks** section for this. Payment events are sent, signed and retried as described in [webhooks.md](./webhooks.md#what-is-built).

How PlugLytics handles the secrets:

- A new random secret (`whsec_` + 32 random bytes) is created for each endpoint.
- It is returned **only once**: in the response to `POST /api/v1/webhooks` or `POST /api/v1/webhooks/:id/rotate-secret`. It is never shown again by any endpoint.
- PlugLytics stores it **encrypted** (AES-256-GCM, using the server-only `WEBHOOK_SIGNING_SECRET` key). It cannot be stored as a one-way hash, because PlugLytics needs the original secret to sign each delivery.
- The encryption key is derived from `WEBHOOK_SIGNING_SECRET` with HKDF-SHA256 (`src/webhookSecrets.js`), which must be at least 16 characters. **If `WEBHOOK_SIGNING_SECRET` changes, stored secrets can no longer be read**, and every endpoint must rotate its secret.
- After a rotation, the previous secret is kept (also encrypted) for 24 hours, so deliveries can carry both signatures.
- Only sandbox (testnet) webhooks are enabled so far. Without the sandbox settings, these endpoints return `503 STELLAR_NOT_CONFIGURED`.
- Each delivery is signed with the secret of the endpoint it is sent to. See [webhooks.md](./webhooks.md#verifying-the-signature).

### POST `/api/v1/webhooks`

Registers a webhook URL for a school.

Request:

```json
{
  "schoolId": 1,
  "url": "https://your-app.example.com/webhooks/pluglytics",
  "events": ["payment.completed", "payment.failed", "subscription.activated"],
  "description": "Main LMS server"
}
```

- `schoolId`: required, the school (customer) the URL belongs to (see `GET /api/v1/api-keys/schools`)
- `url`: required, must start with `https://` (plain `http://` is only allowed for `localhost` in sandbox). A URL with a username or password in it is rejected.
- `events`: optional, the events to send (see `GET /api/v1/webhooks/events`). Leave it out to receive every event.
- `description`: optional, up to 200 characters

Response `201` (`data`):

```json
{
  "id": "wh_7K2M9QX4R8T1VW3N",
  "schoolId": 1,
  "schoolName": "Demo School (placeholder)",
  "url": "https://your-app.example.com/webhooks/pluglytics",
  "events": ["payment.completed", "payment.failed", "subscription.activated"],
  "description": "Main LMS server",
  "environment": "sandbox",
  "secretLastRotatedAt": "2026-11-22T09:00:00.000Z",
  "previousSecretExpiresAt": null,
  "createdAt": "2026-11-22T09:00:00.000Z",
  "status": "active",
  "disabledAt": null,
  "secret": "whsec_EXAMPLE..."
}
```

- **Save `secret` now.** It will not be shown again. Store it in your own app's `.env` (for example `PLUGLYTICS_WEBHOOK_SECRET`).
- Errors: `400 VALIDATION_ERROR`, `404 SCHOOL_NOT_FOUND`, `503 STELLAR_NOT_CONFIGURED`.

### GET `/api/v1/webhooks`

Lists registered webhook URLs, newest first, optionally `?schoolId=1`. Secrets are **never** included, encrypted or not. `status` is `disabled` (with `disabledAt`) after the receiver answered `410 Gone`; nothing more is sent to it.

Response `200` (`data`):

```json
[
  {
    "id": "wh_7K2M9QX4R8T1VW3N",
    "schoolId": 1,
    "schoolName": "Demo School (placeholder)",
    "url": "https://your-app.example.com/webhooks/pluglytics",
    "events": ["payment.completed", "payment.failed", "subscription.activated"],
    "description": "Main LMS server",
    "environment": "sandbox",
    "secretLastRotatedAt": "2026-11-22T09:00:00.000Z",
    "previousSecretExpiresAt": null,
    "createdAt": "2026-11-22T09:00:00.000Z",
    "status": "active",
    "disabledAt": null
  }
]
```

### DELETE `/api/v1/webhooks/:id`

Removes a webhook URL. PlugLytics stops sending events to it right away (including pending retries), and its secret is deleted.

Response `200` (`data`):

```json
{ "id": "wh_7K2M9QX4R8T1VW3N", "deleted": true }
```

### POST `/api/v1/webhooks/:id/rotate-secret`

Creates a new signing secret for the endpoint. Use it if the secret may have leaked, or if you lost it.

Request body: none.

Response `200` (`data`):

```json
{
  "id": "wh_7K2M9QX4R8T1VW3N",
  "secret": "whsec_EXAMPLE...",
  "previousSecretExpiresAt": "2026-11-23T09:30:00.000Z",
  "secretLastRotatedAt": "2026-11-22T09:30:00.000Z"
}
```

- The new `secret` is shown **only once**.
- Errors: `404 WEBHOOK_NOT_FOUND`, `503 STELLAR_NOT_CONFIGURED`.
- Until `previousSecretExpiresAt` (24 hours), deliveries carry both signatures, so you can update your app without missing events. See [webhooks.md](./webhooks.md#rotating-your-secret).

## How payments are detected and webhooks are sent

PlugLytics **does not receive webhooks**. Stellar has no "payment received" callback, so PlugLytics watches the network itself, and then **sends** webhooks to the customer.

### Watching Horizon for incoming payments

- PlugLytics watches the merchant account's payments on Horizon:
  - **Streaming (main method):** it keeps a live connection open to `GET {horizonUrl}/accounts/{merchantPublicKey}/payments?cursor=now` (Server-Sent Events). Horizon pushes each new payment as soon as its ledger closes.
  - **Polling (backup):** every minute, and whenever the stream reconnects, it asks the same endpoint for anything newer than the last `paging_token` it saved, so no payment is missed while the stream was down.
- For each incoming payment, PlugLytics reads the transaction's memo and looks up the payment request with that memo. The memo links the Stellar payment to the payment ID.
- It then runs the checks from [step 3 of the payment flow](#3-confirm-on-horizon) (destination, memo, asset, amount, success, expiry) and sets the status to `completed`, or to `failed` with a `reason`.
- `POST /api/v1/payments/:id/confirm` runs the same check for a single request on demand. It is useful for testing, or if you don't want to wait.

### Sending webhooks to the customer

- After a status changes, PlugLytics sends a signed `POST` to each **webhook URL the customer registered** (see [Webhook endpoints](#webhook-endpoints)).
- Events: `payment.pending`, `payment.completed`, `payment.failed` (with `reason`: `expired`, `cancelled`, `underpaid` or `wrong_asset`), `refund.issued`, `settlement.completed`, `subscription.activated`, `subscription.past_due`, `subscription.cancelled`.
- Each request is signed with **that endpoint's own secret** (from registration): header `X-PlugLytics-Signature: v1=<hex>`, an HMAC-SHA256 of `<timestamp>.<raw body>`, with the timestamp in `X-PlugLytics-Timestamp`.
- See [webhooks.md](./webhooks.md) for the payloads, how the customer verifies the signature, retry rules and duplicate handling.

## Error codes

| HTTP status | Code | When it happens |
| --- | --- | --- |
| 400 | `INVALID_JSON` | The request body is not valid JSON |
| 400 | `VALIDATION_ERROR` | A field is missing or invalid (for example `amount` is `0`) |
| 400 | `UNSUPPORTED_ASSET` | The `asset` and `assetIssuer` pair is not in `supportedAssets` |
| 401 | `AUTH_REQUIRED` | No Bearer token or API key was sent |
| 401 | `AUTH_INVALID` | The token or API key is invalid, expired or revoked |
| 403 | `FORBIDDEN` | Your role cannot use this endpoint |
| 403 | `API_KEY_READ_ONLY` | A customer API key was used on an endpoint that changes data |
| 404 | `PAYMENT_NOT_FOUND` | No payment request has that ID |
| 404 | `SUBSCRIPTION_NOT_FOUND` | No subscription has that ID |
| 404 | `WEBHOOK_NOT_FOUND` | No registered webhook URL has that ID |
| 404 | `INVOICE_NOT_FOUND` | No invoice with that ID was found (for a student: none of their own) |
| 404 | `STUDENT_NOT_FOUND` | No student has that ID |
| 404 | `SCHOOL_NOT_FOUND` | No school has that ID |
| 404 | `API_KEY_NOT_FOUND` | No customer API key has that ID |
| 404 | `TERM_NOT_FOUND` | No term has that ID |
| 409 | `PAYMENT_ALREADY_COMPLETED` | You tried to cancel a request that is already completed, or whose payment has already arrived |
| 409 | `PAYMENT_NOT_PENDING` | The request is expired or cancelled |
| 409 | `DUPLICATE_REFERENCE` | A request with the same `reference` already exists |
| 409 | `INVOICE_NOTHING_DUE` | The invoice is fully paid, or already has a `completed` Stellar payment |
| 409 | `API_KEY_ALREADY_REVOKED` | The customer API key is already revoked |
| 409 | `INVOICE_HAS_COMPLETED_PAYMENT` | The invoice cannot be changed, because it already has a completed or recorded payment |
| 409 | `PAYMENT_ALREADY_PENDING` | The invoice already has a `pending`, unexpired payment request |
| 422 | `RATE_UNAVAILABLE` | No exchange-rate quote is available for this invoice currency and asset |
| 409 | `RELATED_PAYMENT_NOT_FAILED` | `relatedPaymentId`, or the `:id` in `accept-late-payment` or `match-transaction`, is not a `failed` payment request |
| 409 | `TRANSACTION_ALREADY_LINKED` | The transaction is already linked to another payment record |
| 422 | `TRANSACTION_MISMATCH` | The transaction is not on Horizon, did not succeed, or does not match the request's memo, asset, issuer or amount (for `match-transaction`: it has a memo that belongs to another request) |
| 502 | `HORIZON_UNAVAILABLE` | Horizon could not be reached or returned an error. Try again later. |
| 503 | `STELLAR_NOT_CONFIGURED` | `STELLAR_ENV` or a required credential is missing on the server |
| 503 | `PAYMENT_POLICY_INVALID` | A payment policy setting is invalid. `details.problems` names each setting. |
| 500 | `INTERNAL_ERROR` | An unexpected server error occurred |

## Testing with the testnet friendbot

The **friendbot** is a free service that gives new **testnet** accounts 10,000 test XLM. Test XLM has no value, and the friendbot only works on testnet, never on the public network.

### 1. Create two test accounts

You need one account for the merchant (PlugLytics) and one for the customer.

- Open the Stellar Laboratory at <https://laboratory.stellar.org>, choose **Testnet**, and generate a keypair. Do this twice.
- Write down each public key (`G...`) and secret key (`S...`).

### 2. Fund them with the friendbot

Call the friendbot once for each public key:

```bash
curl "https://friendbot.stellar.org?addr=G_YOUR_TESTNET_PUBLIC_KEY"
```

Check the balance on Horizon:

```bash
curl "https://horizon-testnet.stellar.org/accounts/G_YOUR_TESTNET_PUBLIC_KEY"
```

Look for `"asset_type": "native"` under `balances`. It should show `10000.0000000`.

### 3. Configure PlugLytics for sandbox

In your `.env` (never in `.env.example`):

```bash
STELLAR_ENV=sandbox
SANDBOX_MERCHANT_PUBLIC_KEY=<merchant G... key>
SANDBOX_MERCHANT_SECRET_KEY=<merchant S... key>
SANDBOX_WEBHOOK_SIGNING_SECRET=<any long random string; server-only key for encrypting stored webhook secrets>
```

### 4. Run a test payment

1. Log in as the demo admin and call `POST /api/v1/payments` with a small amount, such as `"5.0000000"`.
2. In the Stellar Laboratory (Testnet), use the **customer** account to send a payment to `destination` with the exact `amount` and the `memo` from the response (memo type: text).
3. Call `POST /api/v1/payments/:id/confirm`. The status should change to `completed`.
4. Open `https://horizon-testnet.stellar.org/transactions/<transactionHash>` to see the proof on the network.

### Good to know

- The testnet is **reset** from time to time. Accounts and balances disappear, so fund new accounts with the friendbot again.
- Try the failure cases too: send less than the amount (expect `failed` with reason `underpaid`), send a different asset (expect `failed` with reason `wrong_asset`), leave out the memo (no match), or wait past `expiresAt` (expect `failed` with reason `expired`).

## Security rules

- **Never commit real secret keys.** Keep them only in `.env`, which is listed in `.gitignore`. `.env.example` holds placeholders only.
- Use **different** keys for sandbox and production. Never use a production key on testnet, or the reverse.
- Never log, return or display the merchant secret key or the `WEBHOOK_SIGNING_SECRET` key.
- Show each webhook endpoint's secret only once, when it is created or rotated. Store it encrypted, never log it, and never return it again.
- Always confirm payments on Horizon. Never mark a payment completed based only on what the client says.
- Check the network passphrase so a testnet payment can never be accepted in production.

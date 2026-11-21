# PlugLytics Stellar Payments API

> **Status: planned.** This document describes the payment API PlugLytics will expose. The endpoints below are **not implemented yet**. Today only the credential configuration exists (`src/stellarConfig.js` and `.env.example`). Field names and error codes may change during implementation.

## Contents

- [What is Stellar and why PlugLytics uses it](#what-is-stellar-and-why-pluglytics-uses-it)
- [Payment types](#payment-types)
- [Pricing fields](#pricing-fields)
- [The payment flow](#the-payment-flow)
- [Sandbox vs production](#sandbox-vs-production)
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

Each invoice stores how its price is built. The amount a payment request asks for is the invoice's `finalAmount`.

| Field | Meaning | Rules |
| --- | --- | --- |
| `basePrice` | The price before anything is taken off or added (the invoice `amount`) | 0 or more |
| `scholarshipAmount` | Money taken off by a scholarship | 0 or more. Default `0`. |
| `scholarshipType` | Kind of scholarship: `merit`, `need_based`, `sponsored` or `other` | Required when `scholarshipAmount` is more than 0 |
| `discountPercent` | Discount, as a percent **of the base price** | 0 to 100. Default `0`. |
| `discountCode` | Code used for the discount, if any (for example `EARLY10`) | Optional, up to 50 characters |
| `platformFee` | PlugLytics platform fee added to the price | 0 or more. Default `0`. |
| `transactionFee` | Payment processing fee added to the price | 0 or more. Default `0`. |
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
- A scholarship and discount that together are bigger than the base price plus fees are rejected (`VALIDATION_ERROR`), because `finalAmount` would be negative.
- The same rules are enforced in two places: the API (`src/pricing.js`) and the database (`CHECK` constraints on the `invoices` table in `src/schema.sql`).

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
| POST | `/api/v1/payments` | Admin | Create a pay-per-use payment request |
| GET | `/api/v1/payments` | Admin, or customer API key (own school, read-only) | List payment requests |
| GET | `/api/v1/payments/:id` | Admin, or customer API key (own school, read-only) | Get one payment request |
| POST | `/api/v1/payments/:id/confirm` | Admin | Check Horizon now and mark the payment completed if a match is found |
| POST | `/api/v1/payments/:id/cancel` | Admin | Cancel a pending request |
| POST | `/api/v1/payments/:id/accept-late-payment` | Admin | Record a payment that arrived after expiry as a new `completed` payment |
| POST | `/api/v1/subscriptions` | Admin | Create a seat subscription and its first payment request |
| GET | `/api/v1/subscriptions/:id` | Admin, or customer API key (own school, read-only) | Get a subscription and its current period |
| POST | `/api/v1/webhooks` | Admin | Register a webhook URL and get its signing secret (shown once) |
| GET | `/api/v1/webhooks` | Admin | List your registered webhook URLs |
| DELETE | `/api/v1/webhooks/:id` | Admin | Remove a webhook URL |
| POST | `/api/v1/webhooks/:id/rotate-secret` | Admin | Replace the signing secret (new secret shown once) |

### Customer API keys

Schools (customers) can read their own payments without an admin login, for example to catch up after their webhook server was down.

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
- USDC is planned for production. It appears in this list only once it is enabled on the server.

### POST `/api/v1/payments`

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
- `amount`: required, greater than 0, up to 7 decimal places
- `asset`: optional, defaults to `XLM`
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

Lists payment requests, newest first.

Query parameters (all optional):

- `status`: `pending`, `completed` or `failed`
- `reason`: only used with `status=failed`. One of `expired`, `cancelled`, `underpaid` or `wrong_asset` (for example `?status=failed&reason=expired`)
- `type`: `pay_per_use` or `subscription`
- `page`: page number, starting at 1

Response `200`: `data` is an array of payment request objects (the same shape as above), and `meta.total` is the number of matching requests.

### GET `/api/v1/payments/:id`

Returns one payment request in the same shape as the create response.

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

Cancels a `pending` request. Payments sent after cancelling are not matched. Response `200` contains the request with `"status": "failed"` and `"reason": "cancelled"`.

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

Each customer registers their own webhook URL, and **every registered URL gets its own signing secret**. No secret is ever shared between customers.

How PlugLytics handles the secrets:

- A new random secret (`whsec_` + 32 random bytes) is created for each endpoint.
- It is returned **only once**: in the response to `POST /api/v1/webhooks` or `POST /api/v1/webhooks/:id/rotate-secret`. It is never shown again by any endpoint.
- PlugLytics stores it **encrypted** (AES-256-GCM, using the server-only `WEBHOOK_SIGNING_SECRET` key). It cannot be stored as a one-way hash, because PlugLytics needs the original secret to sign each delivery.
- Each delivery is signed with the secret of the endpoint it is sent to. See [webhooks.md](./webhooks.md#verifying-the-signature).

### POST `/api/v1/webhooks`

Registers a webhook URL.

Request:

```json
{
  "url": "https://your-app.example.com/webhooks/pluglytics",
  "events": ["payment.completed", "payment.failed", "subscription.activated"],
  "description": "Main LMS server"
}
```

- `url`: required, must start with `https://` (plain `http://` is only allowed for `localhost` in sandbox)
- `events`: optional, the events to send. Leave it out to receive every event.
- `description`: optional, up to 200 characters

Response `201` (`data`):

```json
{
  "id": "wh_01JDA2K7PQ",
  "url": "https://your-app.example.com/webhooks/pluglytics",
  "events": ["payment.completed", "payment.failed", "subscription.activated"],
  "description": "Main LMS server",
  "environment": "sandbox",
  "secret": "whsec_9f2c4e7a1b8d3f6e0c5a2b9d4e7f1a3c6b8d0e2f4a6c8e1b3d5f7a9c2e4b6d8f0",
  "createdAt": "2026-11-22T09:00:00.000Z"
}
```

- **Save `secret` now.** It will not be shown again. Store it in your own app's `.env` (for example `PLUGLYTICS_WEBHOOK_SECRET`).

### GET `/api/v1/webhooks`

Lists your registered webhook URLs. Secrets are **never** included.

Response `200` (`data`):

```json
[
  {
    "id": "wh_01JDA2K7PQ",
    "url": "https://your-app.example.com/webhooks/pluglytics",
    "events": ["payment.completed", "payment.failed", "subscription.activated"],
    "description": "Main LMS server",
    "environment": "sandbox",
    "secretLastRotatedAt": "2026-11-22T09:00:00.000Z",
    "createdAt": "2026-11-22T09:00:00.000Z"
  }
]
```

### DELETE `/api/v1/webhooks/:id`

Removes a webhook URL. PlugLytics stops sending events to it right away (including pending retries), and its secret is deleted.

Response `200` (`data`):

```json
{ "id": "wh_01JDA2K7PQ", "deleted": true }
```

### POST `/api/v1/webhooks/:id/rotate-secret`

Creates a new signing secret for the endpoint. Use it if the secret may have leaked, or if you lost it.

Request body: none.

Response `200` (`data`):

```json
{
  "id": "wh_01JDA2K7PQ",
  "secret": "whsec_3a7e1c9b5d2f8e4a0c6b1d7f3e9a5c2b8d4f0e6a1c7b3d9f5e2a8c4b0d6f1e7a3",
  "previousSecretExpiresAt": "2026-11-23T09:30:00.000Z",
  "secretLastRotatedAt": "2026-11-22T09:30:00.000Z"
}
```

- The new `secret` is shown **only once**.
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
| 409 | `PAYMENT_ALREADY_COMPLETED` | You tried to cancel a request that is already completed |
| 409 | `PAYMENT_NOT_PENDING` | The request is expired or cancelled |
| 409 | `DUPLICATE_REFERENCE` | A request with the same `reference` already exists |
| 409 | `RELATED_PAYMENT_NOT_FAILED` | `relatedPaymentId`, or the `:id` in `accept-late-payment`, is not a `failed` payment request |
| 409 | `TRANSACTION_ALREADY_LINKED` | The transaction is already linked to another payment record |
| 422 | `TRANSACTION_MISMATCH` | The transaction is not on Horizon, did not succeed, or does not match the request's memo, asset, issuer or amount |
| 502 | `HORIZON_UNAVAILABLE` | Horizon could not be reached or returned an error. Try again later. |
| 503 | `STELLAR_NOT_CONFIGURED` | `STELLAR_ENV` or a required credential is missing on the server |
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

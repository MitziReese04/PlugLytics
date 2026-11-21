# PlugLytics Stellar Payments API

> **Status: planned.** This document describes the payment API PlugLytics will expose. The endpoints below are **not implemented yet**. Today only the credential configuration exists (`src/stellarConfig.js` and `.env.example`). Field names and error codes may change during implementation.

## Contents

- [What is Stellar and why PlugLytics uses it](#what-is-stellar-and-why-pluglytics-uses-it)
- [Payment types](#payment-types)
- [The payment flow](#the-payment-flow)
- [Sandbox vs production](#sandbox-vs-production)
- [API conventions](#api-conventions)
- [Endpoints](#endpoints)
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
- Once paid, the item is unlocked.

### Seats / subscription

- An institution buys a number of **seats** (users) for a **billing period**, such as 50 seats for one month.
- PlugLytics creates a new payment request at the start of each period.
- Paying it activates (or renews) the subscription until the period ends.
- If a period's payment is not received before it expires, the subscription becomes `past_due`.

> Stellar does not "pull" money from a customer's account the way a card subscription does. Each renewal is a new payment that the customer sends.

## The payment flow

Every payment, of either type, follows the same four steps.

```
1. Create payment request  ->  2. User pays  ->  3. Confirm on Horizon  ->  4. Mark paid
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
- The check runs when the client calls `POST /api/v1/payments/:id/confirm`, and also in the background.

### 4. Mark paid

- The request's status changes from `pending` to `completed`, and the Stellar transaction hash is saved as proof.
- For pay-per-use, the item is unlocked. For a subscription, the seats are activated for the period.
- If a webhook URL is set up, PlugLytics sends a signed `payment.completed` event (see [webhooks.md](./webhooks.md)).

### Payment statuses

| Status | Meaning |
| --- | --- |
| `pending` | Created and waiting for the user to pay |
| `completed` | A matching payment was found on Horizon |
| `expired` | No matching payment arrived before `expiresAt` |
| `cancelled` | Cancelled before payment |
| `underpaid` | A payment with the right memo arrived, but for less than the requested amount |

## Sandbox vs production

PlugLytics chooses the network with the `STELLAR_ENV` environment variable.

| `STELLAR_ENV` | Network | Horizon URL | Network passphrase | Real money? |
| --- | --- | --- | --- | --- |
| `sandbox` | Testnet | `https://horizon-testnet.stellar.org` | `Test SDF Network ; September 2015` | No |
| `production` | Public network (mainnet) | `https://horizon.stellar.org` | `Public Global Stellar Network ; September 2015` | **Yes** |

- `sandbox` reads the variables that start with `SANDBOX_`, and `production` reads the ones that start with `PRODUCTION_`.
- Each environment needs `MERCHANT_PUBLIC_KEY`, `MERCHANT_SECRET_KEY` and `WEBHOOK_SIGNING_SECRET` (with the matching prefix).
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

- **Base path:** `/api/v1/payments` (and `/api/v1/subscriptions`)
- **Authentication:** send `Authorization: Bearer <JWT>` (get a token from `POST /api/v1/auth/login`). The webhook endpoint is the one exception.
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
| GET | `/api/v1/payments` | Admin | List payment requests |
| GET | `/api/v1/payments/:id` | Admin | Get one payment request |
| POST | `/api/v1/payments/:id/confirm` | Admin | Check Horizon now and mark paid if a match is found |
| POST | `/api/v1/payments/:id/cancel` | Admin | Cancel a pending request |
| POST | `/api/v1/subscriptions` | Admin | Create a seat subscription and its first payment request |
| GET | `/api/v1/subscriptions/:id` | Admin | Get a subscription and its current period |
| POST | `/api/v1/payments/webhooks/stellar` | Signed webhook (no JWT) | Receive payment events |

### GET `/api/v1/payments/config`

Returns public information only. Secret keys are **never** returned.

Response `200` (`data`):

```json
{
  "environment": "sandbox",
  "horizonUrl": "https://horizon-testnet.stellar.org",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "merchantPublicKey": "GABC...XYZ",
  "supportedAssets": ["XLM"]
}
```

### POST `/api/v1/payments`

Creates a pay-per-use payment request.

Request:

```json
{
  "type": "pay_per_use",
  "description": "Course analytics export - CS101, Fall term",
  "amount": "25.0000000",
  "asset": "XLM",
  "reference": "export-cs101-fall"
}
```

- `type`: required, must be `pay_per_use`
- `description`: required, 1-200 characters
- `amount`: required, greater than 0, up to 7 decimal places
- `asset`: optional, defaults to `XLM`
- `reference`: optional, your own ID for this charge (also used to stop duplicate requests)

Response `201` (`data`):

```json
{
  "id": "pay_01JD8Z6Q4K",
  "type": "pay_per_use",
  "status": "pending",
  "description": "Course analytics export - CS101, Fall term",
  "amount": "25.0000000",
  "asset": "XLM",
  "destination": "GABC...XYZ",
  "memo": "PL-7F3K9Q",
  "memoType": "text",
  "paymentUri": "web+stellar:pay?destination=GABC...XYZ&amount=25.0000000&memo=PL-7F3K9Q&memo_type=MEMO_TEXT",
  "network": "sandbox",
  "createdAt": "2026-11-21T12:00:00.000Z",
  "expiresAt": "2026-11-21T12:30:00.000Z",
  "paidAt": null,
  "transactionHash": null
}
```

### GET `/api/v1/payments`

Lists payment requests, newest first.

Query parameters (all optional):

- `status`: `pending`, `completed`, `expired`, `cancelled` or `underpaid`
- `type`: `pay_per_use` or `subscription`
- `page`: page number, starting at 1

Response `200`: `data` is an array of payment request objects (the same shape as above), and `meta.total` is the number of matching requests.

### GET `/api/v1/payments/:id`

Returns one payment request in the same shape as the create response.

### POST `/api/v1/payments/:id/confirm`

Asks Horizon right away whether a matching payment has arrived. Calling it more than once is safe.

Request body: none.

Response `200` when paid (`data`):

```json
{
  "id": "pay_01JD8Z6Q4K",
  "status": "completed",
  "amount": "25.0000000",
  "amountReceived": "25.0000000",
  "asset": "XLM",
  "paidAt": "2026-11-21T12:04:31.000Z",
  "transactionHash": "3389e9f0f1a65f19736cacf544c2e825313e8447f569233bb8db39aa607c8889",
  "ledger": 1234567
}
```

Response `200` when nothing has arrived yet: the same shape with `"status": "pending"` and `paidAt` / `transactionHash` set to `null`. Try again in a few seconds.

### POST `/api/v1/payments/:id/cancel`

Cancels a `pending` request. Payments sent after cancelling are not matched. Response `200` contains the request with `"status": "cancelled"`.

### POST `/api/v1/subscriptions`

Creates a seat subscription and the payment request for its first period.

Request:

```json
{
  "plan": "institution_monthly",
  "seats": 50,
  "pricePerSeat": "2.0000000",
  "asset": "XLM",
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
    "destination": "GABC...XYZ",
    "memo": "PL-Q2M8XA",
    "memoType": "text",
    "paymentUri": "web+stellar:pay?destination=GABC...XYZ&amount=100.0000000&memo=PL-Q2M8XA&memo_type=MEMO_TEXT",
    "expiresAt": "2026-11-28T12:00:00.000Z"
  }
}
```

- The amount is `seats x pricePerSeat` (here 50 x 2 = 100).
- When the payment is marked paid, the subscription becomes `active` and `currentPeriodStart` / `currentPeriodEnd` are filled in.
- Subscription statuses: `pending`, `active`, `past_due`, `cancelled`.

### GET `/api/v1/subscriptions/:id`

Returns the subscription, its current period and its latest payment request, in the same shape as the create response.

### POST `/api/v1/payments/webhooks/stellar`

Receives payment events. It uses a signature instead of a JWT.

- Header `X-PlugLytics-Signature`: `v1=<hex>`, an HMAC-SHA256 of `<timestamp>.<raw body>`, signed with `WEBHOOK_SIGNING_SECRET`. The timestamp is sent in the `X-PlugLytics-Timestamp` header.
- Requests with a missing or wrong signature, or a timestamp more than 5 minutes old, are rejected with `401`.
- See [webhooks.md](./webhooks.md#verifying-the-signature) for the full signing rules and a code example.

Request:

```json
{
  "id": "evt_01JD9A4R7T",
  "type": "payment.completed",
  "createdAt": "2026-11-21T12:04:32.000Z",
  "environment": "sandbox",
  "data": {
    "paymentId": "pay_01JD8Z6Q4K",
    "status": "completed",
    "transactionHash": "3389e9f0f1a65f19736cacf544c2e825313e8447f569233bb8db39aa607c8889",
    "paidAt": "2026-11-21T12:04:31.000Z"
  }
}
```

- Events: `payment.pending`, `payment.completed`, `payment.failed` (with `reason`: `expired`, `cancelled`, `underpaid` or `wrong_asset`), `refund.issued`, `settlement.completed`. See [webhooks.md](./webhooks.md#event-types) for full payloads.
- PlugLytics never trusts the webhook by itself: it always re-checks the transaction on Horizon before changing a status.

Response `200` (`data`):

```json
{ "received": true }
```

## Error codes

| HTTP status | Code | When it happens |
| --- | --- | --- |
| 400 | `INVALID_JSON` | The request body is not valid JSON |
| 400 | `VALIDATION_ERROR` | A field is missing or invalid (for example `amount` is `0`) |
| 400 | `UNSUPPORTED_ASSET` | The asset is not in `supportedAssets` |
| 401 | `AUTH_REQUIRED` | No Bearer token was sent |
| 401 | `AUTH_INVALID` | The token is invalid or expired |
| 401 | `WEBHOOK_SIGNATURE_INVALID` | The webhook signature is missing or wrong |
| 403 | `FORBIDDEN` | Your role cannot use this endpoint |
| 404 | `PAYMENT_NOT_FOUND` | No payment request has that ID |
| 404 | `SUBSCRIPTION_NOT_FOUND` | No subscription has that ID |
| 409 | `PAYMENT_ALREADY_PAID` | You tried to cancel a request that is already paid |
| 409 | `PAYMENT_NOT_PENDING` | The request is expired or cancelled |
| 409 | `DUPLICATE_REFERENCE` | A request with the same `reference` already exists |
| 422 | `PAYMENT_UNDERPAID` | A matching payment arrived, but for less than the requested amount |
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
SANDBOX_WEBHOOK_SIGNING_SECRET=<any long random string>
```

### 4. Run a test payment

1. Log in as the demo admin and call `POST /api/v1/payments` with a small amount, such as `"5.0000000"`.
2. In the Stellar Laboratory (Testnet), use the **customer** account to send a payment to `destination` with the exact `amount` and the `memo` from the response (memo type: text).
3. Call `POST /api/v1/payments/:id/confirm`. The status should change to `completed`.
4. Open `https://horizon-testnet.stellar.org/transactions/<transactionHash>` to see the proof on the network.

### Good to know

- The testnet is **reset** from time to time. Accounts and balances disappear, so fund new accounts with the friendbot again.
- Try the failure cases too: send less than the amount (expect `underpaid`), leave out the memo (no match), or wait past `expiresAt` (expect `expired`).

## Security rules

- **Never commit real secret keys.** Keep them only in `.env`, which is listed in `.gitignore`. `.env.example` holds placeholders only.
- Use **different** keys for sandbox and production. Never use a production key on testnet, or the reverse.
- Never log, return or display the merchant secret key or the webhook signing secret.
- Always confirm payments on Horizon. Never mark a payment paid based only on what the client or a webhook says.
- Check the network passphrase so a testnet payment can never be accepted in production.

# PlugLytics Payment Webhooks

> **Status: partly built (sandbox/testnet only).** Registration, signing, the outbox and retries are built, and `payment.pending`, `payment.completed`, `payment.failed` and `refund.issued` are sent. `settlement.completed` and the `subscription.*` events are described here but not sent yet, because settlement reports and subscriptions are not built. See also [payments-api.md](./payments-api.md).

### What is built

- **Outbox:** each event is saved once (`webhook_events`) with its exact JSON body, plus one delivery per subscribed endpoint (`webhook_deliveries`). Only endpoints of the payment's school, in the same environment, that chose the event are sent it. If no endpoint is subscribed, nothing is stored.
- **Sending:** the server sends due deliveries every 15 seconds, and right after a new event (`src/webhookDelivery.js`, started by `src/server.js`).
- **Signing:** each attempt is signed with that endpoint's own secret, as described in [Verifying the signature](#verifying-the-signature).
- **When events are sent:** `payment.pending` when a request is created; `payment.completed` or `payment.failed` when a check on Horizon settles it; `payment.failed` with reason `cancelled` when it is cancelled; and `refund.issued` when a refund payment is sent (its `data` also includes `destinationMemo`).
- **Payment event data** also includes `invoiceId`, and `type` is `invoice` for invoice payments. `reference` is not sent yet, because payment requests have no reference field.

## Contents

- [What is a webhook?](#what-is-a-webhook)
- [Registering your webhook URL](#registering-your-webhook-url)
- [How delivery works](#how-delivery-works)
- [Event types](#event-types)
- [Example payloads](#example-payloads)
- [Verifying the signature](#verifying-the-signature)
- [Retry rules](#retry-rules)
- [Idempotency: handling duplicate events](#idempotency-handling-duplicate-events)
- [Testing webhooks in sandbox](#testing-webhooks-in-sandbox)
- [Checklist](#checklist)

## What is a webhook?

- A webhook is an HTTP request that PlugLytics **sends to your server** when something happens, such as a payment being completed.
- Instead of asking PlugLytics "is it paid yet?" over and over, your server is told as soon as it happens.
- You register a URL with PlugLytics (for example `https://your-app.example.com/webhooks/pluglytics`), and PlugLytics sends a `POST` request there for each event.

## Registering your webhook URL

- Register your URL with `POST /api/v1/webhooks` (see [payments-api.md](./payments-api.md#post-apiv1webhooks)).
- The response includes a **signing secret** that belongs only to that webhook endpoint, for example `whsec_9f2c...`.
- **The secret is shown only once.** Save it straight away in your own `.env`, for example:

  ```bash
  PLUGLYTICS_WEBHOOK_SECRET=whsec_9f2c...
  ```

- Every endpoint gets its **own** secret. No two customers (and no two endpoints) share one, so nobody else can sign events that your server would accept.
- PlugLytics stores your secret **encrypted** and uses it only to sign the events sent to your URL. Its own server keys are never shared with customers.
- If the secret leaks, or you lose it, get a new one with `POST /api/v1/webhooks/:id/rotate-secret` (see [Rotating your secret](#rotating-your-secret)).
- Sandbox and production are registered separately, so each has its own endpoint and its own secret.

## How delivery works

- **Method:** `POST`
- **Body:** JSON (`Content-Type: application/json`)
- **Headers sent with every event:**

| Header | Example | Meaning |
| --- | --- | --- |
| `X-PlugLytics-Event` | `payment.completed` | The event type (also in the body) |
| `X-PlugLytics-Event-Id` | `evt_01JD9A4R7T` | Unique ID of this event. The same on every retry. |
| `X-PlugLytics-Timestamp` | `1795262671` | When this delivery was signed (Unix time, in seconds) |
| `X-PlugLytics-Webhook-Id` | `wh_7K2M9QX4R8T1VW3N` | The registered endpoint this delivery is for |
| `X-PlugLytics-Signature` | `v1=5d41402abc4b2a76...` | The signature, made with your endpoint's secret, used to prove the request came from PlugLytics |

- **Your server must reply** with any `2xx` status (for example `200 OK`) within **10 seconds**.
- Any other status, a timeout, or a connection error counts as a failed delivery, and PlugLytics will retry (see [Retry rules](#retry-rules)).
- Reply quickly, then do slow work (sending emails, updating reports) afterwards.

## Event types

| Event | When it is sent |
| --- | --- |
| `payment.pending` | A payment request was created and is waiting for the customer to pay |
| `payment.completed` | A matching payment was found and confirmed on Horizon. The payment is final. |
| `payment.failed` | The payment request can no longer be paid: it expired, was cancelled, was underpaid, or used the wrong asset |
| `refund.issued` | PlugLytics sent money back to the customer's Stellar account |
| `settlement.completed` | A batch of completed payments was settled (reconciled and reported) for a period |
| `subscription.activated` | A subscription's payment was completed, so its seats are active for the new period (first payment or renewal) |
| `subscription.past_due` | A subscription's payment for the new period was not completed in time, so it is now `past_due` |
| `subscription.cancelled` | A subscription was cancelled. No more renewal payment requests will be created for it. |

Good to know:

- Stellar payments cannot be reversed. A **refund** is a brand-new payment from the merchant account back to the customer, with its own transaction hash.
- A single payment request normally produces `payment.pending` first, then either `payment.completed` or `payment.failed`.
- Events **can arrive out of order** (for example, a retried `payment.pending` may arrive after `payment.completed`). Always use the `status` and `createdAt` fields, not arrival order, to decide what is current.

## Example payloads

Every event has the same outer shape:

```json
{
  "id": "evt_01JD9A4R7T",
  "type": "payment.completed",
  "createdAt": "2026-11-21T12:04:32.000Z",
  "environment": "sandbox",
  "data": { }
}
```

- `id`: unique event ID. Use it to detect duplicates.
- `type`: one of the event types above.
- `createdAt`: when the event happened (ISO 8601, UTC).
- `environment`: `sandbox` (testnet) or `production` (public network).
- `data`: details that depend on the event type.

### `payment.pending`

```json
{
  "id": "evt_01JD9A1K2M",
  "type": "payment.pending",
  "createdAt": "2026-11-21T12:00:00.000Z",
  "environment": "sandbox",
  "data": {
    "paymentId": "pay_01JD8Z6Q4K",
    "type": "pay_per_use",
    "status": "pending",
    "amount": "25.0000000",
    "asset": "XLM",
    "assetIssuer": null,
    "destination": "GABC...XYZ",
    "memo": "PL-7F3K9Q",
    "expiresAt": "2026-11-21T12:30:00.000Z",
    "reference": "export-cs101-fall"
  }
}
```

### `payment.completed`

```json
{
  "id": "evt_01JD9A4R7T",
  "type": "payment.completed",
  "createdAt": "2026-11-21T12:04:32.000Z",
  "environment": "sandbox",
  "data": {
    "paymentId": "pay_01JD8Z6Q4K",
    "type": "pay_per_use",
    "status": "completed",
    "amount": "25.0000000",
    "amountReceived": "25.0000000",
    "asset": "XLM",
    "assetIssuer": null,
    "memo": "PL-7F3K9Q",
    "sourceAccount": "GCUS...TMR",
    "transactionHash": "3389e9f0f1a65f19736cacf544c2e825313e8447f569233bb8db39aa607c8889",
    "ledger": 1234567,
    "paidAt": "2026-11-21T12:04:31.000Z",
    "reference": "export-cs101-fall"
  }
}
```

For a subscription payment, `data.type` is `subscription` and `data` also includes `subscriptionId`, `seats`, `periodStart` and `periodEnd`.

### `payment.failed`

```json
{
  "id": "evt_01JD9B0C3D",
  "type": "payment.failed",
  "createdAt": "2026-11-21T12:30:01.000Z",
  "environment": "sandbox",
  "data": {
    "paymentId": "pay_01JD8Z6Q4K",
    "status": "failed",
    "reason": "expired",
    "amount": "25.0000000",
    "amountReceived": "0",
    "asset": "XLM",
    "assetIssuer": null,
    "memo": "PL-7F3K9Q",
    "transactionHash": null,
    "reference": "export-cs101-fall"
  }
}
```

`reason` is one of:

- `expired`: no matching payment arrived before `expiresAt`
- `cancelled`: the request was cancelled before payment
- `underpaid`: a payment with the right memo arrived, but for less than the amount (`amountReceived` and `transactionHash` show what arrived)
- `wrong_asset`: a payment with the right memo arrived in a different asset

### `refund.issued`

```json
{
  "id": "evt_01JD9C7H8J",
  "type": "refund.issued",
  "createdAt": "2026-11-22T09:15:10.000Z",
  "environment": "sandbox",
  "data": {
    "refundId": "ref_01JD9C7H8K",
    "paymentId": "pay_01JD8Z6Q4K",
    "amount": "25.0000000",
    "asset": "XLM",
    "assetIssuer": null,
    "destination": "GCUS...TMR",
    "reason": "customer_request",
    "transactionHash": "a1f0c6c3e8d14b2b9f2e7d5c4b3a291817161514131211100f0e0d0c0b0a0908",
    "originalTransactionHash": "3389e9f0f1a65f19736cacf544c2e825313e8447f569233bb8db39aa607c8889",
    "issuedAt": "2026-11-22T09:15:08.000Z"
  }
}
```

- `amount` can be less than the original payment for a partial refund.
- `destination` is where the refund was sent. By default it is the account that originally paid. For a payment from an anchor, exchange or other shared account, it is the destination the payer gave **in writing** (or, for an anchor dispute, the anchor), and the refund payment carries the memo they asked for. See [refunds-and-chargebacks.md](./refunds-and-chargebacks.md#2-review).
- `reason` is one of:
  - `customer_request`: the customer asked for a refund
  - `service_issue`: a problem with what was delivered
  - `overpaid`: the extra part of an overpayment
  - `duplicate`: a second payment for the same request
  - `wrong_asset`: a payment in an asset or from an issuer we do not accept
  - `underpaid`: an underpaid amount that was not followed up
  - `late_payment`: a payment that arrived after expiry and was not accepted
  - `dispute`: funds returned to an anchor or card on-ramp after a lost dispute

  These are the refund reasons from [refunds-and-chargebacks.md](./refunds-and-chargebacks.md#1-request). They are separate from the `reason` on a `failed` payment.

### `settlement.completed`

```json
{
  "id": "evt_01JD9D2P5Q",
  "type": "settlement.completed",
  "createdAt": "2026-11-22T00:05:00.000Z",
  "environment": "sandbox",
  "data": {
    "settlementId": "set_01JD9D2P5R",
    "periodStart": "2026-11-21T00:00:00.000Z",
    "periodEnd": "2026-11-22T00:00:00.000Z",
    "asset": "XLM",
    "assetIssuer": null,
    "paymentCount": 12,
    "grossAmount": "340.0000000",
    "refundCount": 1,
    "refundedAmount": "25.0000000",
    "feesPaid": "0.0000100",
    "netAmount": "315.0000000",
    "matchedCount": 13,
    "exceptionCount": 0,
    "paymentIds": ["pay_01JD8Z6Q4K", "pay_01JD8ZB2MQ"]
  }
}
```

- The fields are the same as the daily settlement report (see [settlement.md](./settlement.md#daily-report)). `environment` is at the top level, like in every event.
- `netAmount` = `grossAmount` − `refundedAmount`. `feesPaid` is always in XLM.
- `matchedCount` and `exceptionCount` count payments **and** refunds. If `exceptionCount` is more than 0, an admin must review the day (see [settlement.md](./settlement.md#when-amounts-dont-match)).
- `paymentIds` lists every completed payment in the report. It is shortened to two here.
- Use this event for accounting and reconciliation, not to unlock features. Use `payment.completed` for that.

### `subscription.activated`

```json
{
  "id": "evt_01JD9E5S6T",
  "type": "subscription.activated",
  "createdAt": "2026-11-21T12:10:05.000Z",
  "environment": "sandbox",
  "data": {
    "subscriptionId": "sub_01JD8ZB2MP",
    "plan": "institution_monthly",
    "status": "active",
    "seats": 50,
    "period": "monthly",
    "periodStart": "2026-11-21T12:10:04.000Z",
    "periodEnd": "2026-12-21T12:10:04.000Z",
    "paymentId": "pay_01JD8ZB2MQ",
    "transactionHash": "7c4e2a1b9d8f6e5c3b2a19087f6e5d4c3b2a19087f6e5d4c3b2a19087f6e5d4c"
  }
}
```

- Sent for the first payment and for every renewal. Use it to turn seats on until `periodEnd`.
- It always comes after the matching `payment.completed` event (same `paymentId`).

### `subscription.past_due`

```json
{
  "id": "evt_01JDQF8V9W",
  "type": "subscription.past_due",
  "createdAt": "2026-12-28T12:10:05.000Z",
  "environment": "sandbox",
  "data": {
    "subscriptionId": "sub_01JD8ZB2MP",
    "plan": "institution_monthly",
    "status": "past_due",
    "seats": 50,
    "period": "monthly",
    "previousPeriodEnd": "2026-12-21T12:10:04.000Z",
    "paymentId": "pay_01JDQF8V9X",
    "paymentReason": "expired"
  }
}
```

- `paymentId` is the renewal payment request that was not completed, and `paymentReason` is its `failed` reason (`expired`, `cancelled`, `underpaid` or `wrong_asset`).
- Decide what happens to the seats (for example, a grace period or turning them off) in your own app. A new renewal payment that is completed sends `subscription.activated` again.

### `subscription.cancelled`

```json
{
  "id": "evt_01JDR2B4C5",
  "type": "subscription.cancelled",
  "createdAt": "2026-12-05T08:00:00.000Z",
  "environment": "sandbox",
  "data": {
    "subscriptionId": "sub_01JD8ZB2MP",
    "plan": "institution_monthly",
    "status": "cancelled",
    "seats": 50,
    "period": "monthly",
    "cancellationReason": "customer_request",
    "cancelledAt": "2026-12-05T07:59:58.000Z",
    "accessEndsAt": "2026-12-21T12:10:04.000Z"
  }
}
```

- `cancellationReason` is `customer_request` (the school asked to cancel) or `non_payment` (it stayed `past_due` and was cancelled).
- `accessEndsAt` is the end of the last **paid** period. Keep the seats on until then. It is `null` if no period was ever paid (for example, cancelled while `past_due`).
- `cancelled` is final for the subscription. To subscribe again, the school starts a new subscription, which sends `subscription.activated` when its first payment is completed.

## Verifying the signature

Anyone can send a `POST` request to your webhook URL, so **always check the signature** before trusting an event.

### How the signature is made

1. PlugLytics takes the timestamp (`X-PlugLytics-Timestamp`) and the **raw** request body, exactly as sent.
2. It joins them with a dot: `<timestamp>.<raw body>`
3. It creates an **HMAC-SHA256** of that text, using **your endpoint's signing secret** (the one you got at registration) as the key.
4. It sends the result as hex in the header: `X-PlugLytics-Signature: v1=<hex>`

### How to check it

1. Read the **raw** body. Do not parse the JSON and turn it back into text first, because even one changed space breaks the signature.
2. Make the same HMAC yourself with the secret you got at registration (for example `process.env.PLUGLYTICS_WEBHOOK_SECRET`).
3. Compare it with the header using a **constant-time** comparison. The header can hold more than one signature, separated by commas, while a secret is being rotated. Accept the event if **any** of them matches.
4. Reject the event if the timestamp is more than **5 minutes** old or in the future. This stops someone from re-sending an old, captured request (a "replay attack").
5. If any check fails, reply `401` and ignore the event.

### Example (Node.js / Express)

```js
const crypto = require("crypto");
const express = require("express");

const router = express.Router();
const TOLERANCE_SECONDS = 5 * 60;

function isValidSignature(rawBody, timestamp, signatureHeader, secret) {
  if (!rawBody || !timestamp || !signatureHeader || !secret) {
    return false;
  }

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) {
    return false;
  }

  const expected = Buffer.from(
    crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex"),
    "hex"
  );

  // During a secret rotation the header holds two signatures: "v1=<new>,v1=<old>".
  return signatureHeader.split(",").some((part) => {
    const value = part.trim();
    if (!value.startsWith("v1=")) return false;
    const received = Buffer.from(value.slice(3), "hex");
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  });
}

// express.raw keeps the body as raw bytes so the signature can be checked.
router.post("/webhooks/pluglytics", express.raw({ type: "application/json" }), (req, res) => {
  const rawBody = req.body.toString("utf8");
  const ok = isValidSignature(
    rawBody,
    req.get("X-PlugLytics-Timestamp"),
    req.get("X-PlugLytics-Signature"),
    process.env.PLUGLYTICS_WEBHOOK_SECRET // the secret you got when you registered this URL
  );

  if (!ok) {
    return res.status(401).json({ error: "invalid signature" });
  }

  const event = JSON.parse(rawBody);
  // Handle the event (see "Idempotency" below), then reply quickly.
  res.status(200).json({ received: true });
});

module.exports = router;
```

Notes:

- Register this route **before** any global `express.json()` middleware, or the raw body will already be parsed.
- Never log your signing secret, and keep it only in your `.env`. Sandbox and production endpoints each have their own secret.

### Rotating your secret

1. Call `POST /api/v1/webhooks/:id/rotate-secret`. The response shows the **new** secret once.
2. For the next **24 hours**, PlugLytics signs every delivery with **both** secrets: `X-PlugLytics-Signature: v1=<new>,v1=<old>`. The example above already accepts either one.
3. Put the new secret in your `.env` and restart your app within those 24 hours.
4. After 24 hours, the old secret stops working and only `v1=<new>` is sent.

## Retry rules

If a delivery fails (non-`2xx` reply, timeout after 10 seconds, or connection error), PlugLytics tries again.

| Attempt | Wait after the previous attempt |
| --- | --- |
| 1 | Sent right away |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 | 30 minutes |
| 5 | 2 hours |
| 6 | 6 hours |
| 7 | 12 hours |
| 8 (last) | 24 hours |

- That is **8 attempts over about 2 days**.
- Each retry has the **same event `id`** and **same body**, but a **new timestamp and signature**.
- After the last unsuccessful attempt, the event's delivery is marked `delivery_failed`. Re-sending it by hand is not built yet.
- Delivery states are `pending`, `delivered` and `delivery_failed`. They describe whether **the webhook reached your server**, not the payment. They are separate from the payment status `failed`.
- A `4xx` reply is retried too, in case it was caused by a temporary bug on your side. The one exception is `410 Gone`, which tells PlugLytics to stop sending to that URL: its delivery is marked `delivery_failed` at once, every other pending delivery to it is too, and the endpoint is **disabled** (it shows `"status": "disabled"` in `GET /api/v1/webhooks`). Register the URL again to start receiving events.
- Being down for a while is fine: events wait and are retried. To catch up on the current status, call `GET /api/v1/payments/:id` (or `GET /api/v1/payments?status=completed`) with your school's read-only **customer API key** in the `X-PlugLytics-Api-Key` header. No admin login is needed (see [payments-api.md](./payments-api.md#customer-api-keys)).

## Idempotency: handling duplicate events

Your server **may receive the same event more than once**, for example when your `200` reply was lost on the network and PlugLytics retried. Your code must be safe to run twice.

How to handle it:

1. **Save each event `id`** you have processed (for example, in a `webhook_events` table with `id` as the primary key).
2. When an event arrives, check if its `id` is already saved:
   - **Already saved:** reply `200` straight away and do nothing else.
   - **New:** process it, save the `id`, then reply `200`.
3. Save the `id` and make your changes **in the same database transaction**, so a crash cannot leave one done without the other.
4. Make the change itself safe to repeat. For example, "set status to `completed`" is safe to run twice, but "add 50 seats" is not.
5. Ignore events that would move a payment backwards, such as a late `payment.pending` for a payment already `completed`.

Example table (SQLite):

```sql
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Testing webhooks in sandbox

Always test with `STELLAR_ENV=sandbox`. Sandbox uses the Stellar **testnet**, so no real money moves.

### 1. Register a sandbox webhook and save its secret

1. Register your URL on the **sandbox** PlugLytics server with `POST /api/v1/webhooks`.
2. Copy the `secret` from the response (it is shown only once) into **your app's** `.env`:

```bash
PLUGLYTICS_WEBHOOK_SECRET=<the whsec_... secret from the registration response>
```

Put real values only in `.env`, never in `.env.example` or any committed file.

### 2. Make your local server reachable

- Run your app locally (for example on `http://localhost:3000`).
- If PlugLytics needs to reach your machine from the internet, use a tunnelling tool (such as ngrok or Cloudflare Tunnel) and register the public URL it gives you.

### 3. Send yourself a signed test event

This sends a fake `payment.completed` event, signed the same way PlugLytics does it, so you can test your handler without making a payment:

```bash
node -e '
const crypto = require("crypto");
const secret = process.env.PLUGLYTICS_WEBHOOK_SECRET;
const body = JSON.stringify({
  id: "evt_test_" + Date.now(),
  type: "payment.completed",
  createdAt: new Date().toISOString(),
  environment: "sandbox",
  data: { paymentId: "pay_test_1", status: "completed", amount: "5.0000000", asset: "XLM", assetIssuer: null }
});
const ts = Math.floor(Date.now() / 1000);
const sig = crypto.createHmac("sha256", secret).update(ts + "." + body).digest("hex");
fetch("http://localhost:3000/webhooks/pluglytics", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-PlugLytics-Event": "payment.completed",
    "X-PlugLytics-Timestamp": String(ts),
    "X-PlugLytics-Signature": "v1=" + sig
  },
  body
}).then(r => console.log("status", r.status));
'
```

Run it with your secret loaded, for example `node -r dotenv/config -e '...'`. It needs Node.js 18 or newer for `fetch`.

### 4. Test a real end-to-end payment

1. Fund two testnet accounts with the friendbot (see [payments-api.md](./payments-api.md#testing-with-the-testnet-friendbot)).
2. Create a payment request with `POST /api/v1/payments`. You should receive `payment.pending`.
3. Pay it from the customer testnet account, with the exact amount and memo. You should receive `payment.completed`.
4. Create another request and let it expire. You should receive `payment.failed` with `reason: "expired"`.

### 5. Test the failure cases

- **Wrong signature:** change one character of the signature. Your server should reply `401`.
- **Old timestamp:** sign with a timestamp from 10 minutes ago. Your server should reply `401`.
- **Duplicate:** send the same event (same `id`) twice. The second one should change nothing.
- **Your server is down:** stop your server, trigger an event, start it again, and check that the retry arrives.

## Checklist

- [ ] Signature checked on every request, using the raw body and a constant-time comparison
- [ ] Old timestamps (over 5 minutes) rejected
- [ ] Reply `2xx` within 10 seconds, and do slow work afterwards
- [ ] Event `id`s saved so duplicates are ignored
- [ ] Out-of-order events cannot move a payment backwards
- [ ] Webhook URL registered, and its secret saved as `PLUGLYTICS_WEBHOOK_SECRET` in your `.env` only
- [ ] Separate endpoints (and so separate secrets) for sandbox and production
- [ ] Signature check accepts either signature during a secret rotation

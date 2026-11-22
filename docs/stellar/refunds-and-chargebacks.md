# PlugLytics Refunds and Chargebacks

> **Status: partly built (testnet only).** Requesting, approving, rejecting and issuing refunds is built (see [What is built](#what-is-built)). Disputes and subscription refunds are not built yet. Values in `UPPER_CASE` are placeholders to be decided before going live (**TODO: group decision**). `REFUND_WINDOW_DAYS` and the approval thresholds are already settings in `.env` (see [Payment policy settings](./payments-api.md#payment-policy-settings)); the others are not settings yet. See also [settlement.md](./settlement.md), [webhooks.md](./webhooks.md#refundissued) and [approved-payment-methods.md](./approved-payment-methods.md).

## Contents

- [What is built](#what-is-built)
- [The most important rule](#the-most-important-rule)
- [Who can request a refund](#who-can-request-a-refund)
- [Eligibility window](#eligibility-window)
- [Refund procedure](#refund-procedure)
- [Partial refunds](#partial-refunds)
- [Disputes and chargebacks through anchors and card on-ramps](#disputes-and-chargebacks-through-anchors-and-card-on-ramps)
- [Record-keeping](#record-keeping)
- [Checklist](#checklist)

## What is built

Admin-only endpoints under `/api/v1/refunds` (`src/routes/refunds.js`), and a **Refunds** section plus a **Refund** button on each payment in the admin dashboard's **Stellar Payments** view.

| Method | Path | What it does |
| --- | --- | --- |
| POST | `/api/v1/refunds` | Request a refund: `{ paymentId, amount, reason, note, destination?, destinationMemo? }` |
| GET | `/api/v1/refunds` | List refunds (`?paymentId=`, `?status=`) |
| GET | `/api/v1/refunds/:id` | Get one refund |
| POST | `/api/v1/refunds/:id/approve` | Approve (first approval, or the second admin's) |
| POST | `/api/v1/refunds/:id/reject` | Reject: `{ note }` is required |
| POST | `/api/v1/refunds/:id/issue` | Send the refund payment (**testnet only**) |

How the rules below are enforced:

- **Refundable payments:** a `completed` payment, or a `failed` one with reason `underpaid` (refunding what arrived). Wrong-asset payments cannot be refunded yet, because the asset that arrived is not stored.
- **Amount:** the total of a payment's refunds (including ones still waiting for approval, but not rejected ones) never exceeds `amountReceived` (`409 REFUND_AMOUNT_TOO_HIGH`).
- **Window:** `customer_request` and `service_issue` must be within `REFUND_WINDOW_DAYS` of `paidAt` (`409 REFUND_WINDOW_CLOSED`). While `REFUND_WINDOW_DAYS` is not set, those reasons are refused (`409 REFUND_WINDOW_NOT_SET`, **TODO: group decision**). Operational reasons and `dispute` have no window. The `REFUND_EXCEPTION_APPROVER` exception is not built: a request outside the window is refused.
- **Two-person rule:** a refund above the asset's `REFUND_APPROVAL_THRESHOLD_<ASSET>` needs a second admin who neither requested it nor gave the first approval (`403 SECOND_APPROVER_REQUIRED`). **While no threshold is set, every refund needs two admins** (the safe default, **TODO: group decision**). The database also refuses a second approver who is the requester or the first approver.
- **Destination:** by default the account that paid (`sourceAccount`). A destination given in writing (`destination`, optional `destinationMemo`) is stored as `destinationSource: "written"`. The refund payment's memo is `destinationMemo` if given, otherwise `RF-` plus 8 characters.
- **Issuing:**
  - Refused unless `REFUND_ISSUING_ENABLED=true` (`503 REFUND_ISSUING_DISABLED`). It is `false` by default and on the public demo (`render.yaml`), whose admin password is public. Requesting, approving and rejecting still work, and the dashboard shows **Send testnet refund** disabled, with a note.
  - Refused unless `STELLAR_ENV=sandbox` with the testnet network passphrase (`503 REFUNDS_TESTNET_ONLY`).
  - The destination must exist on the network (`422 DESTINATION_NOT_FOUND`) and, for non-XLM assets, have a trustline (`422 DESTINATION_NO_TRUSTLINE`).
  - The payment is built, signed with the merchant secret key and submitted by `src/stellarRefundSigner.js`, the only code that sends money. PlugLytics pays the network fee.
  - **Never paid twice:** the signed transaction's hash is saved **before** it is submitted. If Horizon rejects it (`502 REFUND_SEND_FAILED`, with the result codes), it was not applied, and the refund stays `approved` to try again. If the result is unclear (`502 REFUND_SEND_UNCONFIRMED`), the next issue first looks that hash up on Horizon: landed means `issued` without sending again; not landed yet means `409 REFUND_SEND_IN_PROGRESS`; expired without landing (after 3 minutes) means it can never apply, so a new payment is sent.
  - On success, the refund is `issued` with its `transactionHash` and `ledger`, and `refund.issued` is sent to the school's webhooks.
- **Not built yet:** dispute records (and the "no open dispute" check), subscription refunds, and reversing an issued refund (refunds are final, like payments).

## The most important rule

- **Stellar payments are final.** Once a payment is in a ledger, nobody can reverse it: not the payer, not PlugLytics, and not Stellar.
- There are **no chargebacks on Stellar itself**.
- A **refund is a new payment** sent **from** the merchant account **back to** the payer. It has its own transaction hash.
- Refunding never changes the original payment. A `completed` payment stays `completed`. The refund is a separate record that points to it.

## Who can request a refund

| Who | Can request a refund for | How |
| --- | --- | --- |
| **School** (institution) | Its own PlugLytics payments (subscriptions and pay-per-use items) | A school admin contacts PlugLytics support |
| **Student** | Tuition and fees they paid to their school | The student asks **their school**. The school decides and submits the request. PlugLytics does not take refund requests from students directly. |
| **PlugLytics admin** | Operational refunds: overpayments, duplicates, wrong-asset payments, underpaid payments not followed up, and late payments not accepted | Raised during reconciliation (see [settlement.md](./settlement.md#when-amounts-dont-match)) |
| **Instructor** | Nothing | Instructors do not make payments in PlugLytics |

## Eligibility window

| Refund type | Window | Notes |
| --- | --- | --- |
| **Requested refund** (customer changed their mind, service problem) | Within `REFUND_WINDOW_DAYS` days of `paidAt` | After the window, only with written approval from `REFUND_EXCEPTION_APPROVER` |
| **Subscription refund** | Only for the **current, unused** part of a period, within `SUBSCRIPTION_REFUND_WINDOW_DAYS` days of the period start | Refund amount follows the rule in `SUBSCRIPTION_REFUND_RULE` (for example, prorated by unused days) |
| **Operational refund** (overpaid, duplicate, wrong asset, underpaid, late payment not accepted) | **No window**. Always refunded once found. | These are our mistakes to fix, not the customer's requests |
| **Dispute through an anchor or card on-ramp** | Follows the anchor's or card network's own deadlines | See [Disputes and chargebacks](#disputes-and-chargebacks-through-anchors-and-card-on-ramps) |

A payment can only be refunded if it is on Horizon. A `failed` request with **no** transaction (for example `expired` with nothing received) has nothing to refund.

## Refund procedure

Every refund follows the same six steps.

```
1. Request  ->  2. Review  ->  3. Approve  ->  4. Send refund payment  ->  5. Record the transaction hash  ->  6. Send refund.issued
```

### 1. Request

- Create a refund request with:
  - `paymentId`: the payment being refunded
  - `amount`: the amount to refund (the full amount, or less for a [partial refund](#partial-refunds))
  - `reason`: for example `customer_request`, `service_issue`, `overpaid`, `duplicate`, `wrong_asset`, `underpaid`, `late_payment`, `dispute`
  - `note`: a short explanation, and who asked for it
- The refund gets its own ID (for example `ref_01JD9C7H8K`) and the status `requested`.

### 2. Review

An admin checks:

- [ ] The original transaction is on Horizon and succeeded (look it up by `transactionHash`).
- [ ] The request is within the [eligibility window](#eligibility-window), or it is an operational refund.
- [ ] The amount is not more than what was received, minus anything already refunded.
- [ ] The **refund destination** is right:
  - Normally it is the account that sent the original payment (`sourceAccount`).
  - If the payment came from an **exchange or other shared account**, the refund needs that platform's memo too. Ask the payer for the exact destination and memo **in writing**, and check it carefully.
  - If the payment came through an **anchor**, follow [the anchor rules](#disputes-and-chargebacks-through-anchors-and-card-on-ramps).
- [ ] The destination account still exists and, for USDC, has a USDC trustline. If not, the refund payment would fail. Ask the payer for a working destination.
- [ ] There is no open dispute for this payment with an anchor or card on-ramp. If there is, stop here (to avoid paying twice).

### 3. Approve

- The reviewer sets the status to `approved` or `rejected`, with a note explaining why.
- **Two-person rule:** refunds above the asset's approval threshold (`REFUND_APPROVAL_THRESHOLD_XLM` or `REFUND_APPROVAL_THRESHOLD_USDC`) need approval from a **second** admin, who must not be the person who requested it.
- If `rejected`, tell the requester why. Nothing is sent.

### 4. Send the refund payment

- Send a new Stellar payment **from the merchant account** to the refund destination:
  - **Same asset and issuer** as the original payment (USDC back as USDC, XLM back as XLM). Never refund in a different asset.
  - **Amount** as approved.
  - **Memo** set to the refund ID (for example `RF-9C7H8K`), or the memo the receiving platform asked for.
- PlugLytics pays the network fee (in XLM) for the refund.
- Only the merchant secret key can send this payment. It is kept only in the server's `.env` (see [payments-api.md](./payments-api.md#security-rules)).
- If the payment fails (for example the destination has no trustline), the refund stays `approved` with an error note. Fix the cause and try again. Never send a second refund before checking that the first one did **not** go through.

### 5. Record the transaction hash

- Once the refund payment is in a ledger, save on the refund record:
  - `transactionHash` and `ledger` of the refund payment
  - `issuedAt` (the ledger close time)
- Set the refund status to `issued`.
- The original payment keeps its status. Its total refunded amount goes up.

### 6. Send the `refund.issued` webhook

- PlugLytics sends `refund.issued` to the school's registered webhook URLs (see [webhooks.md](./webhooks.md#refundissued)).
- The event includes `refundId`, `paymentId`, `amount`, `asset`, `assetIssuer`, `destination`, `reason`, the refund's `transactionHash` and the `originalTransactionHash`.
- For a subscription refund, the subscription is **not** cancelled automatically. If the school is also cancelling, an admin cancels the subscription as a separate step, which sends `subscription.cancelled`.

### Refund statuses

| Status | Meaning |
| --- | --- |
| `requested` | Waiting for review |
| `approved` | Approved, refund payment not sent yet (or being retried) |
| `rejected` | Not approved. Nothing was sent. |
| `issued` | Refund payment is in a ledger. Final. |

## Partial refunds

- A refund can be **less** than the original payment. Examples:
  - Refunding only the **extra** part of an overpayment.
  - Refunding the **unused** part of a subscription period.
  - Refunding one item when the payment covered more.
- A payment can have **more than one** partial refund. Each one is a separate refund record with its own transaction.
- **The total refunded can never be more than the amount received** for that payment. The review step checks this every time.
- Each partial refund sends its own `refund.issued` event. `amount` in the event is the amount of **that** refund, not the running total.

## Disputes and chargebacks through anchors and card on-ramps

Stellar has no chargebacks, but the **step before** Stellar can. If a payer bought USDC through an **anchor** (from a bank or mobile money) or a **card on-ramp**, their bank or card company may let them dispute that purchase. That dispute happens **outside** Stellar, between the payer and the anchor or on-ramp.

### What this means for PlugLytics

- The Stellar payment to the merchant account is still **final**. Nobody can pull it back on-chain.
- The anchor or on-ramp may lose money in the chargeback, and may then **ask the school or PlugLytics to return the funds**, under the agreement with that anchor.
- Only anchors on the **approved anchor list** may be used (see [approved-payment-methods.md](./approved-payment-methods.md#stellar-anchors-pilot-only)). Each approved anchor must have a written agreement that says how disputes and returns work.

### Dispute records

A dispute is tracked as its **own record**, separate from the payment. The payment is never changed: a `completed` payment stays `completed`, and its `reason` field is not used (that field is only for `failed` payments).

| Field | Meaning |
| --- | --- |
| `id` | Dispute ID, for example `dsp_01JDD4P7QR` |
| `paymentId` | The payment being disputed |
| `source` | Where the dispute came from: `anchor` or `card_onramp` |
| `status` | `open`, `won`, `lost` or `refunded` (see below) |
| `openedAt` | When we received the dispute notice |
| `resolvedAt` | When the outcome was decided. `null` while `open`. |
| `notes` | What happened, who handled it, and the anchor's or on-ramp's own dispute reference |

| Status | Meaning |
| --- | --- |
| `open` | Notice received. Refunds for this payment are frozen while we gather evidence. |
| `won` | The dispute was rejected: the payment was valid. Nothing is sent. Final. |
| `lost` | The payer won. The funds must be returned to the anchor or on-ramp, but the refund is not issued yet. Refunds to the payer stay frozen. |
| `refunded` | The funds were returned through the normal refund procedure, and the refund is `issued`. Final. |

Example:

```json
{
  "id": "dsp_01JDD4P7QR",
  "paymentId": "pay_01JD8Z6Q4K",
  "source": "anchor",
  "status": "open",
  "openedAt": "2026-11-25T10:00:00.000Z",
  "resolvedAt": null,
  "notes": "Anchor reference AX-48213: payer disputed the bank deposit used to buy USDC"
}
```

### How a dispute is handled

1. **Receive the notice.** The anchor or on-ramp tells us about the dispute. Create a [dispute record](#dispute-records) with status `open`. Do not change the payment.
2. **Freeze refunds.** Do not refund the payer directly while the dispute record is `open` or `lost`. Otherwise the payer could be paid back twice (once by their bank, once by us).
3. **Gather evidence** and send it to the anchor within its deadline:
   - the payment request (amount, memo, description, dates)
   - the Stellar `transactionHash` and ledger
   - proof of what was delivered (seats activated, report exported, tuition period covered)
   - any messages with the payer
4. **Wait for the outcome.**
   - **Dispute rejected** (the payment was valid): set the dispute to `won` and fill in `resolvedAt`. Nothing is sent.
   - **Dispute accepted** (the payer wins): set the dispute to `lost` and fill in `resolvedAt`. Return the funds **to the anchor**, not to the payer's wallet, using the normal [refund procedure](#refund-procedure) with reason `dispute`. Follow the destination and memo the anchor gives in writing. When the refund is `issued`, set the dispute to `refunded`.
5. **Update the service** if needed. For example, an admin may cancel a subscription whose payment was disputed successfully.

### Rules for disputes

- **Never refund both** the payer and the anchor for the same payment.
- Always check for a dispute record with status `open` or `lost` before approving any refund.
- If an anchor has many disputes, review whether it should stay on the approved list.
- Card payments made **directly** to PlugLytics are not accepted, so card chargebacks can only arrive through an on-ramp.

## Record-keeping

Keep a full record of every refund and dispute. **Never delete** these records. Corrections are made with new records, as with payments (see [settlement.md](./settlement.md#rules-for-handling-exceptions)).

For each refund, store:

- refund ID, `paymentId`, amount, asset and `assetIssuer`
- reason and note
- who requested it, who approved it (and the second approver, if needed), with dates and times
- refund destination and memo, and where the destination came from (original `sourceAccount`, or written instructions)
- refund `transactionHash`, ledger and `issuedAt`
- status history (`requested` → `approved` / `rejected` → `issued`)

For each dispute, keep the [dispute record](#dispute-records) (`id`, `paymentId`, `source`, `status`, `openedAt`, `resolvedAt`, `notes`), and also store:

- the anchor or on-ramp name, and its dispute reference
- the evidence sent, and the dates
- the status history (`open` → `won`, or `open` → `lost` → `refunded`), and the refund sent to the anchor, if any

Also:

- Keep refund and dispute records for `RECORD_RETENTION_YEARS` years.
- Refunds are checked in **daily reconciliation** like any other outgoing payment, and appear in settlement reports as `refundCount` and `refundedAmount` (see [settlement.md](./settlement.md#settlement-reports)).
- Sandbox and production refunds are kept separate.

## Checklist

- [ ] Refund is a **new** payment from the merchant account, never a "reversal"
- [ ] Requester is allowed to ask (school, school on behalf of a student, or PlugLytics admin)
- [ ] Within the eligibility window, or an operational refund
- [ ] Total refunded is not more than the amount received
- [ ] Destination checked (exists, has a trustline, right memo for shared accounts)
- [ ] No open dispute for this payment
- [ ] Second approval for amounts above `REFUND_APPROVAL_THRESHOLD_XLM` / `REFUND_APPROVAL_THRESHOLD_USDC`
- [ ] Same asset and issuer as the original payment
- [ ] Transaction hash recorded and `refund.issued` sent
- [ ] Records kept, never deleted

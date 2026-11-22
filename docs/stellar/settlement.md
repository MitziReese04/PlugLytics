# PlugLytics Settlement and Reconciliation

> **Status: partly built (Stellar Testnet only).** Checking a single payment request against Horizon, accepting late payments and matching payments sent without a memo are built (marked **built** below). Daily and weekly reconciliation runs and settlement reports are not implemented yet; this document describes how they will work. Details may change during implementation. See also [payments-api.md](./payments-api.md) and [webhooks.md](./webhooks.md).

## Contents

- [Key words](#key-words)
- [How fast Stellar settles](#how-fast-stellar-settles)
- [Which assets we accept](#which-assets-we-accept)
- [How funds reach the merchant account](#how-funds-reach-the-merchant-account)
- [Reconciliation](#reconciliation)
- [Settlement reports](#settlement-reports)
- [When amounts don't match](#when-amounts-dont-match)
- [Sandbox notes](#sandbox-notes)
- [Checklist](#checklist)

## Key words

- **Settlement:** the moment money has really moved and cannot be taken back. On Stellar, this happens when the transaction is included in a ledger.
- **Ledger:** a "page" of confirmed transactions on Stellar. A new ledger closes about every 5 seconds.
- **Reconciliation:** checking that our payment records and the real transactions on Stellar agree with each other.
- **Merchant account:** the PlugLytics Stellar account that receives payments (`MERCHANT_PUBLIC_KEY`).
- **Stroop:** the smallest Stellar unit. 1 XLM = 10,000,000 stroops. Every asset on Stellar has 7 decimal places.

## How fast Stellar settles

- A Stellar transaction is final as soon as its ledger closes, which usually takes **about 5 seconds**.
- There is **no waiting period** and no "pending clearance" like with cards or bank transfers.
- There are **no chargebacks**. Once a payment is in a ledger, the sender cannot reverse it. A refund is a new payment that we send back (see `refund.issued` in [webhooks.md](./webhooks.md#refundissued)).
- Network fees are tiny (the base fee is 0.00001 XLM per operation) and are paid by **whoever sends** the transaction. Customers pay the fee for their payments. We only pay fees when we send refunds or move funds out.

This means:

- A payment can be marked `completed` as soon as it is confirmed on Horizon.
- "Settlement" in PlugLytics is mostly about **accounting**: grouping completed payments into daily or weekly reports and checking that everything matches.

## Which assets we accept

| Asset | What it is | Status | Why |
| --- | --- | --- | --- |
| `XLM` | Stellar's own currency (the "native" asset) | Approved. Default asset for sandbox and the pilot. | Works on every account with no setup. Good for testing. |
| `USDC` | A US-dollar stablecoin issued by Circle | Approved. Planned default asset for production. | 1 USDC is designed to stay worth 1 USD, so prices don't change with the market |

Good to know:

- **XLM's price goes up and down.** A course price of `25 XLM` may be worth a different amount of money tomorrow. For real customers, **USDC is recommended**, so prices stay stable.
- **An asset is more than its code.** On Stellar, an asset is a code **plus** the issuer's account. Anyone can create a fake token called "USDC". We only accept USDC from Circle's official issuer:
  - Public network issuer: `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`
    - Source: <https://www.circle.com/usdc-multichain/stellar>
  - Testnet issuer: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`
    - Source: Circle developer docs, "Transfer USDC on Stellar" quickstart
    - Get free testnet USDC from the Circle Faucet at <https://faucet.circle.com> (your testnet account needs a USDC trustline first).
  - Always double-check these against Circle's official documentation before going live.
- **USDC needs a trustline.** Before the merchant account can receive USDC, it must add a **trustline** to the USDC issuer (a one-time setting that says "this account accepts this asset"). XLM needs no trustline.
- The list of accepted assets is returned by `GET /api/v1/payments/config` as `supportedAssets`. A payment in any other asset (or from a different issuer) is treated as `wrong_asset`.

## How funds reach the merchant account

```
Customer wallet  ->  Stellar network (about 5 seconds)  ->  PlugLytics merchant account
```

1. The customer sends the payment **straight to the merchant account**, with the memo from the payment request.
2. When the ledger closes, the funds are **in the merchant account**. There is no middleman holding the money and no payout delay.
3. PlugLytics sees the payment on Horizon, matches it to the payment request using the memo, and marks it `completed`.
4. If the institution wants the money somewhere else (for example, to convert USDC to a bank deposit), that is a **separate, manual step** done by an admin through an exchange or anchor. It is not part of the payment flow.

Keep in mind:

- Every Stellar account must keep a small **minimum balance** in XLM (a reserve). It grows a little for each trustline. Never withdraw the full XLM balance.
- Only the merchant secret key can move funds out. Keep it in `.env` only, as described in [payments-api.md](./payments-api.md#security-rules).

## Reconciliation

Reconciliation answers one question: **"Do our records and the Stellar network agree?"**

### What we compare

| Our side (PlugLytics database) | Stellar side (Horizon) |
| --- | --- |
| Payment requests: amount, asset, memo, status, transaction hash | Payments received by the merchant account |
| Refunds we recorded | Payments sent from the merchant account |
| Expected balance | Actual account balance |

### Checking a single payment (built)

Before daily reconciliation exists, a pending payment request is checked one at a time when someone opens it with `GET /api/v1/payments/:id`. That check uses the same matching rules as the daily run below (memo, asset code **and** issuer, amount in stroops, before `expiresAt`), and marks the request `completed` or `failed` with a reason (see [payments-api.md](./payments-api.md#get-apiv1paymentsid)). It only looks at that one request. It does not find payments without a memo, duplicates, or balance problems, which still need the daily and weekly runs.

### Daily reconciliation (automatic)

Runs once a day, shortly after midnight UTC, for the previous day.

1. **Fetch** all payments to and from the merchant account for the day from Horizon:
   - `GET {horizonUrl}/accounts/{merchantPublicKey}/payments?join=transactions&order=asc&limit=200`
   - `join=transactions` includes the memo in each result.
   - Follow the `next` links until there are no more results. Save the last `paging_token`, so the next run starts where this one stopped.
2. **Keep only successful transactions** (`transaction_successful: true`).
3. **Match** each incoming payment to a payment request using:
   - the memo
   - the asset code **and** issuer
   - the amount
4. **Sort every item** into one of these groups:
   - `matched`: Horizon payment and payment record agree
   - `amount_mismatch`: same memo, but a different amount (underpaid or overpaid)
   - `asset_mismatch`: same memo, but a different asset or issuer
   - `unmatched_onchain`: a payment arrived, but its memo is missing or unknown
   - `unmatched_record`: our record says `completed`, but the transaction is not on Horizon
   - `duplicate`: more than one payment arrived for the same memo
5. **Check outgoing payments** (refunds) against our refund records in the same way.
6. **Save** the results, create the [daily report](#daily-report), and send `settlement.completed` (see [webhooks.md](./webhooks.md#settlementcompleted)).
7. **Alert an admin** if anything is not `matched`.

### How reconciliation results relate to payment statuses

A **reconciliation result** describes how our records compare with Horizon. A **payment status** (and `reason`) describes the payment request itself. They are separate, but they line up like this:

| Reconciliation result | Payment status | Payment `reason` | What it means |
| --- | --- | --- | --- |
| `matched` | `completed` | none | Right memo, asset and amount. Nothing to do. |
| `amount_mismatch` (less than requested) | `failed` | `underpaid` | Not enough arrived. Follow up with a new linked request or refund it (see [When amounts don't match](#when-amounts-dont-match)). |
| `amount_mismatch` (more than requested) | `completed` | none | The payment **counts**, because the full amount arrived. Only the extra is an exception: refund it or record it as a credit. |
| `asset_mismatch` | `failed` | `wrong_asset` | Different asset or issuer. Refund it in the same asset it arrived in. |

- An overpaid payment is the only case where the payment is `completed` but reconciliation still reports a mismatch.
- The payment status is final, but the reconciliation exception stays open until the follow-up or refund shows up as `matched`.

### Weekly reconciliation (deeper check)

Runs every Monday for the previous week (Monday to Sunday, UTC).

1. **Add up the week's daily reports** and check that the totals agree with each other.
2. **Check the balance**, separately for each asset:

   ```
   opening balance
   + payments received
   - refunds sent
   - network fees paid
   - withdrawals
   = closing balance
   ```

   The closing balance must equal the real balance from `GET {horizonUrl}/accounts/{merchantPublicKey}`.
3. **Re-check every open item** from the week's daily runs and close the ones that have been fixed.
4. **Look for gaps**: every payment request that was `completed` during the week must have exactly one matching transaction hash.
5. **Check follow-ups**: every `underpaid` or late `expired` request must have a linked follow-up (`relatedPaymentId`) or a refund. If not, it stays an open exception.

### Rules for comparing amounts

- **Never compare amounts as floating-point numbers** (for example JavaScript `Number`). `0.1 + 0.2` is not exactly `0.3`.
- Compare amounts as **integers in stroops** (amount × 10,000,000), or as exact strings with 7 decimal places.
- Always compare the **asset code and issuer** together, not just the code.

### Why we keep our own copy

- Public Horizon servers may not keep the full history forever.
- Save the transaction hash, ledger number, amount, asset, memo and source account for every matched payment in our database, so reports can be rebuilt at any time.

## Settlement reports

### Daily report

Created by the daily reconciliation. One report per asset, per day.

| Field | Example | Meaning |
| --- | --- | --- |
| `settlementId` | `set_01JD9D2P5R` | Report ID (same as in the `settlement.completed` event) |
| `periodStart` / `periodEnd` | `2026-11-21T00:00:00Z` / `2026-11-22T00:00:00Z` | Time covered (UTC) |
| `environment` | `sandbox` | `sandbox` or `production` |
| `asset` | `XLM` | Asset code this report covers |
| `assetIssuer` | `null` | Issuer of the asset: `null` for XLM, Circle's issuer address for USDC |
| `paymentCount` | `12` | Number of completed payments |
| `grossAmount` | `340.0000000` | Total received |
| `refundCount` / `refundedAmount` | `1` / `25.0000000` | Refunds sent |
| `feesPaid` | `0.0000100` | Network fees we paid (XLM, for refunds and withdrawals) |
| `netAmount` | `315.0000000` | `grossAmount` − `refundedAmount` |
| `matchedCount` | `13` | Payments and refunds that matched (here 12 payments + 1 refund) |
| `exceptionCount` | `0` | Payments and refunds that did not match (must be 0 to close the day cleanly) |
| `paymentIds` | `["pay_01JD8Z6Q4K", "pay_01JD8ZB2MQ", ...]` | IDs of the completed payments in this report |

The `settlement.completed` webhook event carries exactly these fields (see [webhooks.md](./webhooks.md#settlementcompleted)). In the event, `environment` is at the top level, like in every event.

Each report also has a line-by-line list, which can be exported as CSV. The `assetIssuer` column is empty for XLM:

```
date,paymentId,type,memo,asset,assetIssuer,amountExpected,amountReceived,transactionHash,ledger,result
2026-11-21,pay_01JD8Z6Q4K,pay_per_use,PL-7F3K9Q,XLM,,25.0000000,25.0000000,3389e9f0...8889,1234567,matched
```

### Weekly report

- The totals of the week's daily reports.
- The balance check result (expected vs. actual closing balance).
- A list of open exceptions, with their age in days.

### Who uses the reports

- **Admins:** to check that every payment is accounted for and to handle exceptions.
- **Finance or accounting:** for bookkeeping, invoices and audits.
- **Institutions:** a copy of their own payments, to compare with their records.

## When amounts don't match

Every item that is not `matched` becomes an **exception**. An admin must review it.

| Problem | What it looks like | What to do |
| --- | --- | --- |
| **Underpaid** | Right memo, but less than the requested amount | The request is `failed` with `reason: underpaid` and **stays that way**. Contact the customer, then either create a new request for the remaining amount with `relatedPaymentId` set to the failed one (see [payments-api.md](./payments-api.md#post-apiv1payments)), or refund what they sent. A later payment with the old memo does not complete the old request. |
| **Overpaid** | Right memo, but more than the requested amount | Payment is `completed`. Refund the extra amount, or record it as a credit if the customer agrees. |
| **Wrong asset** | Right memo, but a different asset or a fake issuer | Payment is `failed` with `reason: wrong_asset`. Refund it in the **same asset** it arrived in. Never treat a fake "USDC" as real. |
| **No memo or unknown memo** | Money arrived, but we can't tell which request it is for | Put it in the `unmatched_onchain` list. Use the sender's account, amount and time to find the customer and the request it was meant for. Then either match it with `POST /api/v1/payments/:id/match-transaction` (**built**; see [payments-api.md](./payments-api.md#post-apiv1paymentsidmatch-transaction)), which creates a new `completed` record linked with `relatedPaymentId`, or refund it. Admins can do this from the dashboard's **Stellar Payments** view (**Match transaction**). |
| **Duplicate payment** | Two payments with the same memo | Keep the first, refund the second. |
| **Paid after expiry** | Correct payment, but it arrived after `expiresAt` | The request stays `failed` with `reason: expired`. Contact the customer, then either refund the payment, or accept it with `POST /api/v1/payments/:id/accept-late-payment` (**built**; see [payments-api.md](./payments-api.md#post-apiv1paymentsidaccept-late-payment)), or the **Accept late payment** button in the dashboard's **Stellar Payments** view. That creates a **new** `completed` record linked with `relatedPaymentId` and sends `payment.completed` for it. |
| **Record without a transaction** | Our database says `completed`, but there is no matching transaction on Horizon | **Serious.** Do not unlock more features for this customer. Check if the wrong network was used or the record was changed by mistake, and escalate. |
| **Balance doesn't match** | Weekly balance check fails | Check for missing fees, withdrawals or refunds that were not recorded. Do not close the week until it is explained. |

### Rules for handling exceptions

- **`failed` is final.** Never change a failed payment request back to `pending` or to `completed`. Follow it up with a new, linked record (`relatedPaymentId`) or a refund.
- **Every manual action needs a note.** Each follow-up request, accepted late payment or refund must record who did it, when, and why.
- **Refunds go back to the account that paid** by default, in the same asset. The exception is a payment from an anchor, exchange or other shared account: then the refund goes to the destination and memo the payer gives **in writing** (or, for an anchor dispute, the anchor). Every refund is recorded like any other refund (so it appears in reconciliation too). See [refunds-and-chargebacks.md](./refunds-and-chargebacks.md#2-review).
- **Fix problems by adding new records** (refunds, adjustments), not by deleting old ones. This keeps the history complete for audits.
- **Close exceptions within 7 days.** Exceptions open for longer are flagged in the weekly report.
- Mark an exception as resolved only after the fix shows up as `matched` in the next reconciliation.

## Sandbox notes

- In sandbox (`STELLAR_ENV=sandbox`), everything works the same way, but on the **testnet**, with test money.
- Use the friendbot to fund test accounts (see [payments-api.md](./payments-api.md#testing-with-the-testnet-friendbot)).
- The testnet is **reset** from time to time. After a reset, old transaction hashes no longer exist, so sandbox reconciliation will report `unmatched_record` for older items. This is expected. Clear old sandbox data after a reset.
- Sandbox and production reports must **never be mixed**. Every report includes `environment` for this reason.
- Good things to test: an exact payment, an underpayment, an overpayment, a payment with no memo, a duplicate payment, a refund, and a wrong-asset payment.

## Checklist

- [ ] Daily reconciliation runs and saves its `paging_token`
- [ ] Payments matched on memo, asset code **and** issuer, and amount
- [ ] Amounts compared as stroops or exact strings, never floats
- [ ] Weekly balance check passes for every asset
- [ ] Every exception reviewed and closed within 7 days
- [ ] Every manual change logged with who, when and why
- [ ] Sandbox and production data kept separate
- [ ] USDC issuer double-checked against Circle's official docs before going live

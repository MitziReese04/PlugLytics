# PlugLytics Settlement and Reconciliation

> **Status: planned.** Settlement and reconciliation are not implemented yet. This document describes how they will work. Details may change during implementation. See also [payments-api.md](./payments-api.md) and [webhooks.md](./webhooks.md).

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
| `XLM` | Stellar's own currency (the "native" asset) | Supported now (default) | Works on every account with no setup. Good for testing. |
| `USDC` | A US-dollar stablecoin issued by Circle | Planned for production | 1 USDC is designed to stay worth 1 USD, so prices don't change with the market |

Good to know:

- **XLM's price goes up and down.** A course price of `25 XLM` may be worth a different amount of money tomorrow. For real customers, **USDC is recommended**, so prices stay stable.
- **An asset is more than its code.** On Stellar, an asset is a code **plus** the issuer's account. Anyone can create a fake token called "USDC". We only accept USDC from Circle's official issuer:
  - Public network issuer: `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`
  - Always double-check this against Circle's official documentation before going live. The testnet issuer is different, so look it up in Circle's docs too.
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
| `environment` | `production` | `sandbox` or `production` |
| `asset` | `USDC` | Asset this report covers |
| `paymentCount` | `12` | Number of completed payments |
| `grossAmount` | `340.0000000` | Total received |
| `refundCount` / `refundedAmount` | `1` / `25.0000000` | Refunds sent |
| `feesPaid` | `0.0000100` | Network fees we paid (XLM, for refunds and withdrawals) |
| `netAmount` | `315.0000000` | `grossAmount` − `refundedAmount` |
| `matchedCount` | `12` | Items that matched |
| `exceptionCount` | `0` | Items that did not match (must be 0 to close the day cleanly) |

Each report also has a line-by-line list, which can be exported as CSV:

```
date,paymentId,type,memo,asset,amountExpected,amountReceived,transactionHash,ledger,result
2026-11-21,pay_01JD8Z6Q4K,pay_per_use,PL-7F3K9Q,XLM,25.0000000,25.0000000,3389e9f0...8889,1234567,matched
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
| **Underpaid** | Right memo, but less than the requested amount | Payment stays `failed` with `reason: underpaid`. Contact the customer. Either they send the difference with the same memo, or we refund what they sent. |
| **Overpaid** | Right memo, but more than the requested amount | Payment is `completed`. Refund the extra amount, or record it as a credit if the customer agrees. |
| **Wrong asset** | Right memo, but a different asset or a fake issuer | Payment is `failed` with `reason: wrong_asset`. Refund it in the **same asset** it arrived in. Never treat a fake "USDC" as real. |
| **No memo or unknown memo** | Money arrived, but we can't tell which request it is for | Put it in the `unmatched_onchain` list. Use the sender's account, amount and time to find the customer, then link it by hand or refund it. |
| **Duplicate payment** | Two payments with the same memo | Keep the first, refund the second. |
| **Paid after expiry** | Correct payment, but it arrived after `expiresAt` | Contact the customer. Either accept it (and mark it completed by hand) or refund it. |
| **Record without a transaction** | Our database says `completed`, but there is no matching transaction on Horizon | **Serious.** Do not unlock more features for this customer. Check if the wrong network was used or the record was changed by mistake, and escalate. |
| **Balance doesn't match** | Weekly balance check fails | Check for missing fees, withdrawals or refunds that were not recorded. Do not close the week until it is explained. |

### Rules for handling exceptions

- **Never edit a payment record without a note.** Every manual change must record who made it, when, and why.
- **Refunds go back to the account that paid**, in the same asset, and are recorded like any other refund (so they appear in reconciliation too).
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

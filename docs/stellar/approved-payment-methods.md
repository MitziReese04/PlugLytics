# PlugLytics Approved Payment Methods

> **Status: planned.** This is the proposed payment-method policy for Stellar Payments in PlugLytics. Nothing here is implemented yet. The statuses, users and amount limits below are **defaults to be confirmed** by the school and PlugLytics before going live. Amount limits are placeholders.

## Contents

- [Who pays for what](#who-pays-for-what)
- [Status meanings](#status-meanings)
- [Approved payment methods](#approved-payment-methods)
- [Method details](#method-details)
- [Not accepted](#not-accepted)
- [Rules for all methods](#rules-for-all-methods)

## Who pays for what

| User | Pays for | Can use Stellar payment methods? |
| --- | --- | --- |
| **School** (institution) | PlugLytics subscriptions (seats) and pay-per-use items | Yes |
| **Student** | Tuition and fees owed to their school | Yes, for the methods marked below |
| **Instructor** | Nothing. Instructors do not make payments in PlugLytics. | No |

## Status meanings

| Status | Meaning |
| --- | --- |
| `approved` | Can be used in production by the users listed |
| `pilot only` | Only in sandbox, or with schools in an agreed pilot. Not offered to everyone in production. |
| `not allowed` | Never accepted. Payments are refunded (see [settlement.md](./settlement.md#when-amounts-dont-match)). |

## Approved payment methods

| Method | Who can use it | Minimum amount | Maximum amount | Status |
| --- | --- | --- | --- | --- |
| **Stellar USDC** (Circle issuer only) | School, Student | `USDC_MIN_AMOUNT` (TODO: group decision) | `USDC_MAX_AMOUNT` (TODO: group decision) | `approved` (planned default for production) |
| **XLM** (Stellar's native asset) | School | `XLM_MIN_AMOUNT` (TODO: group decision) | `XLM_MAX_AMOUNT` (TODO: group decision) | `approved` (default for sandbox and the pilot) |
| **Stellar anchors** (local currency on/off-ramps) | School, Student | `ANCHOR_MIN_AMOUNT` (placeholder) | `ANCHOR_MAX_AMOUNT` (placeholder) | `pilot only` |

- Instructors cannot use any method, because they never pay through PlugLytics.
- Limits apply **per payment request**. They are set separately for sandbox and production.
- The XLM and USDC limits are real settings in `.env` (see [Payment policy settings](./payments-api.md#payment-policy-settings)). Empty means no limit. The anchor limits are not settings yet, because anchor payments are not built.

## Method details

### Stellar USDC: `approved`

- A US-dollar stablecoin. 1 USDC is designed to stay worth 1 USD, so prices stay stable. This makes it the **recommended** method for subscriptions and tuition.
- USDC is the **planned default asset for production**, because of its stable dollar value.
- Only USDC from **Circle's official issuer** is accepted:
  - Production: `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`
  - Sandbox (testnet): `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`
- In payment requests, responses and events, `asset` is `USDC` and `assetIssuer` is the Circle issuer address above for the current network.
- The merchant account needs a USDC trustline (see [settlement.md](./settlement.md#which-assets-we-accept)).
- Note: USDC payments are still being built. This status is the policy for when it is live.

### XLM: `approved`

- Stellar's own currency. It needs no trustline, so it is the easiest asset for testing.
- XLM has no issuer, so in payment requests, responses and events `asset` is `XLM` and `assetIssuer` is `null`.
- Its price changes with the market, so an amount in XLM can be worth more or less tomorrow. For that reason:
  - **Schools** can use it. It is the default asset for sandbox and the pilot.
  - **Students** cannot use it for tuition, so they are protected from price changes.
- XLM is the default asset for sandbox and the pilot. USDC is the planned default for production (see [payments-api.md](./payments-api.md#post-apiv1payments)).

### Stellar anchors: `pilot only`

- An **anchor** is a regulated company that converts between local currency (for example, a bank deposit or mobile money) and assets on Stellar.
  - **On-ramp:** the payer pays the anchor in local currency, and the anchor sends **USDC** to the PlugLytics merchant account.
  - **Off-ramp:** a school converts USDC it received back into local currency in its bank account.
- To PlugLytics, an on-ramp payment is a normal **Stellar USDC** payment. It must arrive with the right memo, asset, issuer and amount, like any other payment.
- Only anchors on an **approved anchor list** can be used. The list is the `APPROVED_ANCHORS` setting (anchor home domains, empty by default; see [Payment policy settings](./payments-api.md#payment-policy-settings)). It is not decided yet (**TODO: group decision**): each anchor must be checked first (licences, supported countries, fees and identity checks).
- Anchor fees are paid by the payer. The amount that reaches the merchant account must still match the payment request.

## Not accepted

These are `not allowed`. What happens depends on how the payment is sent:

- **Other blockchains** (and testnet money in production) **never reach** the merchant account, because it only exists on the Stellar network. Nothing arrives, so there is nothing to match or refund.
- **Other Stellar assets** sent with a valid memo **are matched** to the payment request, which becomes `failed` with reason `wrong_asset`. They are then refunded in the asset they arrived in, the same as in [settlement.md](./settlement.md#when-amounts-dont-match).
- **Everything else** on this list is refused or refunded where possible.

- **Any other Stellar asset**, including tokens named "USDC" from any issuer other than Circle's official one.
- **USDC or other crypto on other blockchains** (for example Ethereum, Solana or Bitcoin). PlugLytics only accepts payments on the Stellar network.
- **Testnet assets in production.** Sandbox and production are separate networks, so test money is never accepted as real.
- **Payments from anchors that are not on the approved anchor list.**
- **Card, bank transfer or cash paid directly to PlugLytics.** Local currency can only come in through an approved anchor.
- **Claimable balances** (Stellar payments that the receiver must claim). Only direct payments to the merchant account are matched.
- **Payments by instructors.** Instructors have no payment flow.

Payments **without the memo** are not matched automatically. They are handled as exceptions: an admin either matches them to the right request with [`POST /api/v1/payments/:id/match-transaction`](./payments-api.md#post-apiv1paymentsidmatch-transaction), or refunds them (see [settlement.md](./settlement.md#when-amounts-dont-match)).

## Rules for all methods

- Every payment must go to the merchant account, with the memo from its payment request.
- Amounts below the minimum or above the maximum are rejected when the payment request is created (`VALIDATION_ERROR`).
- A payment in an asset that is not approved becomes `failed` with reason `wrong_asset`, and is refunded in the asset it arrived in.
- Each status here is a policy decision. Changing a status (for example, moving anchors from `pilot only` to `approved`) must be agreed with the school and recorded in this document.

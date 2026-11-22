// Builds, signs and submits a refund payment from the merchant account.
// See "Refund procedure" in docs/stellar/refunds-and-chargebacks.md.
//
// This is the only code that sends money. It is TESTNET ONLY: it refuses any
// network passphrase other than Stellar's testnet one. The Stellar SDK is loaded
// only here, and only when a refund is actually sent (Jest cannot load the SDK's
// ESM-only dependency, so the tests replace this module with a fake).

const TX_TIMEOUT_SECONDS = 180;
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

class RefundSendError extends Error {
  // definite: true means the transaction was certainly NOT applied, so it is safe
  // to try again. false means the outcome is unknown (for example a timeout).
  constructor(message, { definite, codes = null } = {}) {
    super(message);
    this.definite = definite;
    this.codes = codes;
  }
}

async function sendRefundPayment({
  horizonUrl, networkPassphrase, merchantPublicKey, merchantSecretKey,
  destination, asset, assetIssuer, amount, memo, onSigned,
}) {
  if (networkPassphrase !== TESTNET_PASSPHRASE) {
    throw new RefundSendError("Refund payments are testnet only", { definite: true });
  }
  // Loaded here so the rest of the app (and Jest) never needs the SDK.
  const { Keypair, TransactionBuilder, Operation, Asset, Memo, Horizon, BASE_FEE } = require("@stellar/stellar-sdk");

  let keypair;
  try {
    keypair = Keypair.fromSecret(merchantSecretKey);
  } catch (error) {
    throw new RefundSendError("The merchant secret key is not a valid Stellar secret key", { definite: true });
  }
  if (keypair.publicKey() !== merchantPublicKey) {
    // Never include either key in the message.
    throw new RefundSendError("The merchant secret key does not belong to the merchant public key", { definite: true });
  }

  const server = new Horizon.Server(horizonUrl, { allowHttp: horizonUrl.startsWith("http://") });
  let account;
  let fee = BASE_FEE;
  try {
    account = await server.loadAccount(merchantPublicKey);
    fee = String(await server.fetchBaseFee().catch(() => Number(BASE_FEE)));
  } catch (error) {
    throw new RefundSendError(`Could not load the merchant account from Horizon: ${error.message}`, { definite: true });
  }

  const stellarAsset = asset === "XLM" ? Asset.native() : new Asset(asset, assetIssuer);
  const transaction = new TransactionBuilder(account, { fee, networkPassphrase })
    .addOperation(Operation.payment({ destination, asset: stellarAsset, amount }))
    .addMemo(Memo.text(memo))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();
  transaction.sign(keypair);

  const hash = Buffer.from(transaction.hash()).toString("hex");
  const expiresAt = new Date(Number(transaction.timeBounds.maxTime) * 1000).toISOString();
  // Recorded before submitting, so an unclear result can be checked later instead
  // of sending a second refund.
  await onSigned({ hash, expiresAt });

  try {
    const result = await server.submitTransaction(transaction);
    return { hash: result.hash || hash, ledger: result.ledger || null };
  } catch (error) {
    const response = error && error.response;
    const codes = response && response.data && response.data.extras && response.data.extras.result_codes;
    if (response && response.status === 400 && codes) {
      // Horizon rejected it: the transaction was not applied.
      const detail = [codes.transaction, ...(codes.operations || [])].filter(Boolean).join(", ");
      throw new RefundSendError(`Horizon rejected the refund payment (${detail})`, { definite: true, codes });
    }
    throw new RefundSendError(`The refund payment's result is unknown: ${error.message}`, { definite: false });
  }
}

module.exports = { TX_TIMEOUT_SECONDS, TESTNET_PASSPHRASE, RefundSendError, sendRefundPayment };

/**
 * x402 — pay-per-use agent access to the inspection verifier.
 *
 * The main product is autonomous escrow: humans fund deposits, the AI verdict
 * releases them. This module is the OTHER direction the same engine can face:
 * an external agent pays per request to consume Aivy's verifier as a service,
 * using the x402 payment-required flow (HTTP 402 + X-PAYMENT header).
 *
 * Honesty constraints, in order of importance:
 *  - x402 has no Hedera facilitator today, so this implements the protocol
 *    SHAPE (402 challenge → X-PAYMENT retry → verified settlement) with a
 *    custom scheme, `hedera-hbar-transfer`: the agent makes a real HBAR
 *    transfer on Hedera testnet and presents the transaction id; we verify
 *    it against the MIRROR NODE — recipient, amount, recency, replay — and
 *    only then run the inspection. No payment is ever assumed or mocked.
 *  - Fully isolated: nothing here touches the checkout/escrow flow, and the
 *    whole path is gated behind X402_ENABLED=1.
 *
 * Env:
 *   X402_ENABLED=1                 turn the endpoint on
 *   X402_PAY_TO=0x…                EVM address paid per request (defaults to relayer)
 *   X402_PRICE_TINYBAR=10000000    price per inspection (default 0.1 ℏ)
 */

const PRICE_TINYBAR = () => BigInt(process.env.X402_PRICE_TINYBAR ?? "10000000"); // 0.1 ℏ
const MAX_AGE_SECONDS = 600; // payment must be recent — stale txs are refused

// replay guard: a transaction id buys exactly one inspection (per boot — a
// production service would persist this; honest limitation, documented)
const usedPayments = new Set<string>();

export function x402Enabled(): boolean {
  return process.env.X402_ENABLED === "1";
}

export function x402PayTo(fallback: string): string {
  return process.env.X402_PAY_TO ?? fallback;
}

/** The 402 challenge body — x402-shaped `accepts` array. */
export function paymentRequirements(payTo: string, resource: string) {
  return {
    x402Version: 1,
    error: "X-PAYMENT header is required",
    accepts: [
      {
        scheme: "hedera-hbar-transfer",
        network: "hedera-testnet",
        asset: "HBAR",
        maxAmountRequired: PRICE_TINYBAR().toString(), // tinybar
        payTo,
        resource,
        description:
          "Aivy AI inspection verdict: condition + liveness-challenge judgement over one evidence photo, signed by the verifier key.",
        mimeType: "application/json",
        maxTimeoutSeconds: MAX_AGE_SECONDS,
        extra: {
          how:
            `Transfer >= maxAmountRequired tinybar to payTo on Hedera testnet, then retry with ` +
            `X-PAYMENT: base64({"scheme":"hedera-hbar-transfer","network":"hedera-testnet","payload":{"transactionId":"0.0.x-ssssssssss-nnnnnnnnn"}})`,
          note: "custom scheme — no x402 facilitator exists for Hedera yet; settlement is verified against the public mirror node",
        },
      },
    ],
  };
}

async function mirror(pathname: string): Promise<any | null> {
  const res = await fetch(`https://testnet.mirrornode.hedera.com/api/v1${pathname}`);
  if (!res.ok) return null;
  return res.json();
}

// payTo is an EVM address; mirror-node transfer lists use 0.0.x account ids
let payToAccountCache: { evm: string; id: string } | null = null;
async function accountIdFor(evmAddress: string): Promise<string | null> {
  if (payToAccountCache?.evm === evmAddress.toLowerCase()) return payToAccountCache.id;
  const j = await mirror(`/accounts/${evmAddress.toLowerCase()}`);
  const id = j?.account ?? null;
  if (id) payToAccountCache = { evm: evmAddress.toLowerCase(), id };
  return id;
}

export type X402Verification =
  | { ok: true; transactionId: string; amountTinybar: string }
  | { ok: false; status: number; error: string };

/**
 * Verify an X-PAYMENT header against the mirror node. Every rejection path
 * is explicit — this function is the reason the endpoint can say "paid"
 * without lying.
 */
export async function verifyPayment(header: string, payTo: string): Promise<X402Verification> {
  let payment: any;
  try {
    payment = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return { ok: false, status: 400, error: "X-PAYMENT is not valid base64 JSON" };
  }
  if (payment?.scheme !== "hedera-hbar-transfer" || payment?.network !== "hedera-testnet") {
    return { ok: false, status: 400, error: "unsupported scheme/network — see the 402 challenge's accepts[]" };
  }
  const txId = String(payment?.payload?.transactionId ?? "");
  // mirror-node format: 0.0.x-seconds-nanos
  if (!/^\d+\.\d+\.\d+-\d+-\d+$/.test(txId)) {
    return { ok: false, status: 400, error: "payload.transactionId must be mirror-node format 0.0.x-ssss-nnnn" };
  }
  if (usedPayments.has(txId)) {
    return { ok: false, status: 409, error: "payment already spent — one inspection per transaction" };
  }

  const payToId = await accountIdFor(payTo);
  if (!payToId) return { ok: false, status: 502, error: "could not resolve payTo account on mirror node" };

  const j = await mirror(`/transactions/${txId}`);
  const entries: any[] = j?.transactions ?? [];
  if (entries.length === 0) return { ok: false, status: 402, error: "transaction not found on mirror node (allow ~5s after submit)" };
  // one transaction id can carry several entries (e.g. a lazily-created
  // account yields a CRYPTOUPDATEACCOUNT child before the ETHEREUMTRANSACTION
  // that moved the money) — judge the entry that actually credited payTo
  const tx = entries.find(
    (e) => e.result === "SUCCESS" && (e.transfers ?? []).some((t: any) => t.account === payToId && BigInt(t.amount) > 0n)
  );
  if (!tx) {
    const results = entries.map((e) => `${e.name}:${e.result}`).join(", ");
    return { ok: false, status: 402, error: `no SUCCESS entry credits ${payToId} (entries: ${results})` };
  }

  const ageSeconds = Date.now() / 1000 - Number(tx.consensus_timestamp);
  if (!(ageSeconds >= 0 && ageSeconds <= MAX_AGE_SECONDS)) {
    return { ok: false, status: 402, error: `payment too old (${Math.round(ageSeconds)}s > ${MAX_AGE_SECONDS}s)` };
  }

  const credited = (tx.transfers ?? []).find((t: any) => t.account === payToId && BigInt(t.amount) > 0n);
  const amount = credited ? BigInt(credited.amount) : 0n;
  if (amount < PRICE_TINYBAR()) {
    return {
      ok: false,
      status: 402,
      error: `insufficient payment: ${amount} tinybar credited to ${payToId}, price is ${PRICE_TINYBAR()}`,
    };
  }

  usedPayments.add(txId);
  return { ok: true, transactionId: txId, amountTinybar: amount.toString() };
}

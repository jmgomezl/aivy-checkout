/**
 * Aivy Checkout relayer — Stage 2 off-chain half.
 *
 * Responsibilities:
 *  1. VERIFIER SIGNER  — sign ItemVerdicts with the relayer key (baseline;
 *     swap to the 0G TEE key later via CheckoutEscrow.setVerifier).
 *  2. SUBMITTER        — call verifyItemAndRelease on the escrow contract.
 *  3. EVENT LISTENER   — watch DepositReleased / CheckoutResolved.
 *  4. HCS LOGGER       — seal the final receipt to a Hedera Consensus Service
 *     topic. If HCS creds are absent, write the receipt to offchain/receipts/
 *     and say so loudly — never silently skip.
 *
 * Env (.env or exported):
 *   HEDERA_RPC_URL        e.g. https://testnet.hashio.io/api
 *   RELAYER_PRIVATE_KEY   secp256k1 hex key (verifier + tx sender)
 *   ESCROW_ADDRESS        deployed CheckoutEscrow
 *   HCS_TOPIC_ID          optional, e.g. 0.0.12345
 *   HEDERA_OPERATOR_ID    optional, e.g. 0.0.99999
 *   HEDERA_OPERATOR_KEY   optional, DER/hex private key for HCS submit
 *
 * Run: npm run relayer            (listener mode)
 *      npm run relayer -- demo    (drives one full happy-path item submit,
 *                                  assumes checkout already created+funded)
 */
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { mkdirSync, writeFileSync } from "node:fs";
import { ItemVerdict, signVerdict } from "./payload.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const RPC = process.env.HEDERA_RPC_URL ?? "";
const PK = process.env.RELAYER_PRIVATE_KEY ?? "";
const ESCROW = process.env.ESCROW_ADDRESS ?? "";

const ESCROW_ABI = [
  "function verifyItemAndRelease(uint256 checkoutId, (uint256 checkoutId, bytes32 itemId, bool verdict, bytes32 imageHash, bytes32 nonceHash, uint256 deadline) v, bytes sig)",
  "function getCheckout(uint256) view returns (tuple(address host, address tenant, uint256 deposit, uint64 deadline, uint8 requiredItems, uint8 passedItems, uint8 status))",
  "event ItemVerified(uint256 indexed checkoutId, bytes32 indexed itemId, bool pass, bytes32 imageHash)",
  "event DepositReleased(uint256 indexed checkoutId, address indexed tenant, uint256 amount)",
  "event CheckoutResolved(uint256 indexed checkoutId, address indexed host, uint256 amount)",
];

function req(name: string, v: string): string {
  if (!v) throw new Error(`Missing env ${name} — see relayer.ts header.`);
  return v;
}

// ---------------------------------------------------------------------------
// 1+2. Verifier signer + submitter
// ---------------------------------------------------------------------------
export async function signAndSubmit(v: ItemVerdict): Promise<string> {
  const provider = new JsonRpcProvider(req("HEDERA_RPC_URL", RPC));
  const wallet = new Wallet(req("RELAYER_PRIVATE_KEY", PK), provider);
  const escrow = new Contract(req("ESCROW_ADDRESS", ESCROW), ESCROW_ABI, wallet);

  const sig = await signVerdict(wallet, v);
  console.log(`[relayer] signed verdict item=${v.itemId.slice(0, 10)}… pass=${v.verdict}`);

  const tx = await escrow.verifyItemAndRelease(
    v.checkoutId,
    [v.checkoutId, v.itemId, v.verdict, v.imageHash, v.nonceHash, v.deadline],
    sig
  );
  const receipt = await tx.wait();
  console.log(`[relayer] submitted -> tx ${receipt?.hash}`);
  return receipt?.hash ?? "";
}

// ---------------------------------------------------------------------------
// 4. HCS logger (with loud file fallback)
// ---------------------------------------------------------------------------
interface FinalReceipt {
  checkoutId: string;
  outcome: "RELEASED" | "RESOLVED_TO_HOST";
  counterparty: string;
  amount: string;
  txHash: string;
  ts: string;
}

async function sealReceipt(r: FinalReceipt): Promise<void> {
  const topicId = process.env.HCS_TOPIC_ID ?? "";
  const opId = process.env.HEDERA_OPERATOR_ID ?? "";
  const opKey = process.env.HEDERA_OPERATOR_KEY ?? "";

  if (topicId && opId && opKey) {
    // Lazy import so the relayer runs without @hashgraph/sdk installed until needed.
    const { Client, TopicMessageSubmitTransaction } = await import("@hashgraph/sdk");
    const client = Client.forTestnet().setOperator(opId, opKey);
    const tx = await new TopicMessageSubmitTransaction({
      topicId,
      message: JSON.stringify(r),
    }).execute(client);
    const rec = await tx.getReceipt(client);
    console.log(`[relayer] ✅ receipt sealed to HCS topic ${topicId} (status ${rec.status})`);
    client.close();
    return;
  }

  // Fallback: file receipt, loudly labeled.
  mkdirSync(new URL("./receipts/", import.meta.url), { recursive: true });
  const path = new URL(`./receipts/checkout-${r.checkoutId}-${Date.now()}.json`, import.meta.url);
  writeFileSync(path, JSON.stringify(r, null, 2));
  console.warn(
    `[relayer] ⚠️  HCS creds not set (HCS_TOPIC_ID / HEDERA_OPERATOR_ID / HEDERA_OPERATOR_KEY).\n` +
      `[relayer] ⚠️  Receipt written to ${path.pathname} instead — HCS sealing is STUBBED, not done.`
  );
}

// ---------------------------------------------------------------------------
// 3. Event listener
// ---------------------------------------------------------------------------
export async function listen(): Promise<void> {
  const provider = new JsonRpcProvider(req("HEDERA_RPC_URL", RPC));
  const escrow = new Contract(req("ESCROW_ADDRESS", ESCROW), ESCROW_ABI, provider);

  console.log(`[relayer] listening on ${ESCROW} …`);

  escrow.on(escrow.filters.ItemVerified(), (checkoutId, itemId, pass, imageHash) => {
    console.log(`[relayer] ItemVerified checkout=${checkoutId} item=${String(itemId).slice(0, 10)}… pass=${pass} img=${String(imageHash).slice(0, 10)}…`);
  });

  escrow.on(escrow.filters.DepositReleased(), async (checkoutId, tenant, amount, ev) => {
    console.log(`[relayer] 🎉 DepositReleased checkout=${checkoutId} tenant=${tenant} amount=${amount}`);
    await sealReceipt({
      checkoutId: String(checkoutId),
      outcome: "RELEASED",
      counterparty: String(tenant),
      amount: String(amount),
      txHash: ev?.log?.transactionHash ?? "",
      ts: new Date().toISOString(),
    });
  });

  escrow.on(escrow.filters.CheckoutResolved(), async (checkoutId, host, amount, ev) => {
    console.log(`[relayer] ⏰ CheckoutResolved checkout=${checkoutId} host=${host} amount=${amount}`);
    await sealReceipt({
      checkoutId: String(checkoutId),
      outcome: "RESOLVED_TO_HOST",
      counterparty: String(host),
      amount: String(amount),
      txHash: ev?.log?.transactionHash ?? "",
      ts: new Date().toISOString(),
    });
  });
}

// ---------------------------------------------------------------------------
if (process.argv[1]?.endsWith("relayer.ts")) {
  listen().catch((e) => {
    console.error("[relayer] fatal:", e);
    process.exit(1);
  });
}

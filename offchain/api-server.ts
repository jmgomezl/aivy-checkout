/**
 * Aivy Checkout API — Stage 4 backend.
 *
 * Thin HTTP layer over the proven pipeline (storage -> vision -> sign -> chain).
 * Zero web-framework deps: node http + JSON bodies (images as base64 data URLs;
 * nginx caps body size). Designed to bundle to one file with esbuild and run
 * under pm2 on a RAM-constrained box (same posture as OculusVault).
 *
 * Endpoints:
 *   GET  /api/health
 *   POST /api/verify-human        {nullifier, proof?}   — World ID gate (sim or real)
 *   POST /api/demo/checkout       {}                    — create+fund a fresh demo checkout
 *   GET  /api/checkout/:id                              — on-chain state
 *   POST /api/checkout/:id/evidence {itemName, imageDataUrl, nullifier}
 *        -> stores evidence, AI verdict, signs, submits, returns result
 *
 * Env: RPC_URL (default local anvil), RELAYER_PRIVATE_KEY (default anvil pk),
 *      ESCROW_ADDRESS (unset -> deploys a fresh escrow at boot: demo mode),
 *      PORT (default 8791), WORLD_APP_ID/WORLD_ACTION (unset -> simulator mode).
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  getAddress,
  isAddress,
  keccak256,
  toUtf8Bytes,
  parseEther,
} from "ethers";
import { itemIdOf, signVerdict, ItemVerdict } from "./payload.js";
import { storeEvidence } from "./storage-0g.js";
import { judge } from "./vision-agent.js";
import {
  resolveRelayerKey,
  resolveWorldMode,
  newCheckoutId,
  generateLivenessNonce,
  sanitizeForPrompt,
} from "./guards.js";

const PORT = Number(process.env.PORT ?? 8791);
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
// Throws unless a real key is configured (or NODE_ENV marks a dev run) — the
// relayer key is the escrow's verifier, so it has no safe default.
const RELAYER_PK = resolveRelayerKey(process.env);
// Throws unless WORLD_APP_ID is set or simulated personhood is explicitly
// opted into — the simulator accepts any nullifier a client invents.
const WORLD_MODE = resolveWorldMode(process.env);

type TemplateItem = { name: string; desc: string; nonce: string };
type Template = { id: string; title: string; payer: string; blurb: string; icon: string; depositHbar?: number; geoLock?: boolean; timeLockMinutes?: number; brain?: "0g-compute" | "openai"; items: TemplateItem[] };

// The platform: one escrow + evidence + AI-verdict engine, many inspection
// templates. Anything physical that two parties dispute at a handover.
const TEMPLATES: Template[] = [
  {
    id: "rental_checkout",
    title: "Rental Checkout",
    payer: "hosts & property managers",
    geoLock: false, timeLockMinutes: 30, // stage-friendly: no GPS prompt on the flagship
    // The flagship's lamp challenge is STATE-critical ("glowing"). Tested on
    // the real evidence: qwen-7B on 0G missed the unlit lamp entirely (its
    // "seen" didn't even mention it); GPT caught it. Frontier perception for
    // state challenges is a designer-grade choice — presence-based templates
    // below stay on the TEE-verified 0G brain.
    brain: "openai",
    blurb: "Tenant proves the place is fine; deposit releases itself.",
    icon: "🏠",
    items: [
      // Two items, not three: this gets demoed live and repeatedly, so every
      // item is another chance for venue wifi or a bad angle to derail it.
      // Two still shows the progression and the auto-release on the last pass.
      // Both objects exist in every venue on earth. The nonce props are the
      // two things we physically carry — a yellow plush toy and a green
      // glowing lamp — distinctive, unguessable objects no stock photo has.
      // Condition wording has to be satisfiable by the actual object. "no
      // chips, burns or deep scratches" on a venue table fails honestly —
      // every venue table has all three — and a verifier told to fail when
      // uncertain will keep failing it. Describe structural damage, not wear.
      { name: "chair", desc: "chair with an intact seat and backrest, no cracks or broken legs", nonce: "place the yellow plush toy with green hair on the seat of the chair" },
      { name: "laptop", desc: "laptop open, screen intact and casing not cracked", nonce: "place the green glowing joystick lamp next to the laptop" },
    ],
  },
  {
    // Not an object's condition but a document's authenticity — the same
    // machinery, pointed at expense fraud: screenshots of screens, the same
    // receipt claimed twice, totals edited after the fact. A challenge
    // committed on-chain before the photo exists defeats the first two,
    // because a stored image cannot satisfy a challenge nobody had published.
    id: "expense_receipt",
    title: "Expense Receipt",
    payer: "finance teams & expense platforms",
    blurb: "Claimant proves the receipt is real and in hand; the reimbursement releases itself.",
    icon: "🧾",
    items: [
      { name: "receipt_total", desc: "printed receipt with a legible total and date, photographed as paper and not as a screen", nonce: "hold the receipt flat with your thumb at the bottom edge" },
      { name: "receipt_header", desc: "the same receipt showing the venue name across the top", nonce: "lay a yellow pen across the top of the receipt" },
    ],
  },
  {
    id: "vehicle_return",
    title: "Vehicle Return",
    payer: "rental fleets & insurers",
    depositHbar: 10,
    geoLock: true, timeLockMinutes: 15, // insurer-grade: WHERE + tight WHEN // premium escrow — requires a higher assurance tier
    blurb: "Bumper-to-bumper condition receipt before the keys change hands.",
    icon: "🚗",
    items: [
      { name: "front_bumper", desc: "front bumper and hood, no dents or scratches", nonce: "hold your open palm on the hood while shooting the bumper" },
      { name: "driver_side", desc: "driver-side panels and mirror intact", nonce: "point at the side mirror with one finger" },
      { name: "dashboard", desc: "dashboard showing fuel level and odometer, no warning lights", nonce: "hold two fingers beside the odometer" },
    ],
  },
  {
    id: "scooter_return",
    title: "Scooter Return",
    payer: "micromobility fleets & insurers",
    blurb: "Rider proves the scooter came back whole, braking, and charged.",
    icon: "🛴",
    items: [
      { name: "scooter_deck", desc: "scooter deck and stem upright, no cracks or bends", nonce: "rest one open palm flat on the middle of the deck" },
      { name: "brake_lever", desc: "brake lever on the handlebar, intact and attached", nonce: "squeeze the brake lever with your hand visible in frame" },
      { name: "battery_readout", desc: "powered-on dashboard showing the battery level", nonce: "point at the lit battery readout with one finger" },
    ],
  },
  {
    id: "delivery_handover",
    title: "Delivery Handover",
    payer: "merchants & 3PLs",
    geoLock: true, timeLockMinutes: 15, // the address IS the claim
    blurb: "Courier proves the parcel arrived intact, at the right door.",
    icon: "📦",
    items: [
      { name: "parcel_intact", desc: "sealed parcel with no crush damage or tears", nonce: "place the parcel next to the door number plate" },
      { name: "label_visible", desc: "shipping label readable in frame", nonce: "point at the label with one finger" },
    ],
  },
  {
    id: "shelf_audit",
    title: "Retail Shelf Audit",
    payer: "CPG brands & distributors",
    geoLock: true, timeLockMinutes: 30, // prove the store, not the stockroom photo
    blurb: "Merchandiser proves the product is on-shelf, priced, and faced.",
    icon: "🛒",
    items: [
      { name: "product_facing", desc: "product visible and front-facing on the shelf", nonce: "hold one finger under the leftmost product" },
      { name: "price_tag", desc: "shelf price tag present and readable", nonce: "point at the price tag" },
      { name: "shelf_context", desc: "wide shot showing the full shelf section", nonce: "include the aisle sign in the frame" },
    ],
  },
];
const templateById = (id: string) => TEMPLATES.find((t) => t.id === id);

const provider = new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
const relayerWallet = new Wallet(RELAYER_PK, provider);
const relayer = new NonceManager(relayerWallet);

let escrow: Contract;
let network = "local"; // "hedera-testnet" | "hedera-mainnet" | "local"
// checkout ids come from guards.newCheckoutId() — 48 bits of CSPRNG entropy

// sybil gate: one human -> one active demo checkout
const humanToCheckout = new Map<string, number>();
// single-login UX: first wallet a human provides is remembered forever
const nullifierWallet = new Map<string, string>();

// ── assurance tiers ─────────────────────────────────────────────────
// World ID verification level changes ECONOMIC TERMS, not just access:
// higher assurance -> bigger deposits the platform will escrow for you.
//   device  — World App install, no Orb (live today)
//   selfie  — Selfie Check beta (flag-gated until World enables access)
//   orb     — Proof of Human (live today; in-app step-up)
type Tier = "device" | "selfie" | "orb";
const TIER_CAP_HBAR: Record<Tier, number> = { device: 2, selfie: 10, orb: 100 };
const TIER_RANK: Record<Tier, number> = { device: 0, selfie: 1, orb: 2 };
const SELFIE_ENABLED = process.env.SELFIE_CHECK_ENABLED === "1"; // flip at the venue
const nullifierTier = new Map<string, Tier>();

function tierOf(nullifier: string): Tier {
  return nullifierTier.get(nullifier) ?? "device";
}
function recordTier(nullifier: string, level: string | undefined) {
  const t: Tier = level === "orb" ? "orb" : level === "selfie" ? "selfie" : "device";
  const prev = tierOf(nullifier);
  if (TIER_RANK[t] > TIER_RANK[prev] || !nullifierTier.has(nullifier)) nullifierTier.set(nullifier, t);
}
// nullifiers that passed a REAL World ID proof this boot (live mode only)
const verifiedNullifiers = new Set<string>();
const checkoutMeta = new Map<
  number,
  { items: TemplateItem[]; tenant: string; template: string; icon: string; geoLock: boolean; timeLockMinutes: number; brain?: "0g-compute" | "openai"; noncesReady?: Promise<void> }
>();
const evidenceLog = new Map<number, Array<Record<string, unknown>>>();

const ARTIFACT = JSON.parse(
  readFileSync(new URL("../out/CheckoutEscrow.sol/CheckoutEscrow.json", import.meta.url), "utf8")
);

async function boot() {
  const addr = process.env.ESCROW_ADDRESS;
  if (addr) {
    escrow = new Contract(addr, ARTIFACT.abi, relayer);
    console.log(`[api] using existing escrow at ${addr}`);
  } else {
    const f = new ContractFactory(ARTIFACT.abi, ARTIFACT.bytecode.object, relayer);
    const c = await f.deploy(relayerWallet.address);
    await c.waitForDeployment();
    escrow = new Contract(await c.getAddress(), ARTIFACT.abi, relayer);
    console.log(`[api] DEMO MODE — deployed fresh escrow at ${await escrow.getAddress()}`);
  }
  const chainId = Number((await provider.getNetwork()).chainId);
  network = chainId === 296 ? "hedera-testnet" : chainId === 295 ? "hedera-mainnet" : "local";
  console.log(`[api] relayer/verifier: ${relayerWallet.address} rpc: ${RPC} network: ${network} (chainId ${chainId})`);
}

// ---------------------------------------------------------------------------
// World ID gate
// ---------------------------------------------------------------------------
async function verifyHuman(body: any): Promise<{ ok: boolean; nullifier: string; mode: string }> {
  const appId = process.env.WORLD_APP_ID;
  if (WORLD_MODE === "simulator") {
    // Only reachable when the operator explicitly opted in (see guards.ts).
    const simNullifier = String(body?.nullifier ?? "").slice(0, 128);
    if (!simNullifier) return { ok: false, nullifier: "", mode: "simulator" };
    console.warn(
      `[api] ⚠️  SIMULATED personhood (no WORLD_APP_ID) for nullifier ${simNullifier.slice(0, 18)}…`,
    );
    return { ok: true, nullifier: simNullifier, mode: "simulator" };
  }
  if (appId && body?.proof) {
    // Real verification against the World Developer Portal.
    const res = await fetch(`https://developer.worldcoin.org/api/v2/verify/${appId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nullifier_hash: body.proof.nullifier_hash,
        merkle_root: body.proof.merkle_root,
        proof: body.proof.proof,
        verification_level: body.proof.verification_level,
        action: process.env.WORLD_ACTION ?? "aivy-checkout",
      }),
    });
    const j: any = await res.json();
    // Require an explicit success: a malformed or error-shaped 200 must not
    // count as a proof.
    const ok = res.ok && j?.success === true;
    if (ok) verifiedNullifiers.add(body.proof.nullifier_hash);
    return { ok, nullifier: body.proof.nullifier_hash, mode: "world-id" };
  }
  const nullifier = String(body?.nullifier ?? "").slice(0, 128);
  if (!nullifier) return { ok: false, nullifier: "", mode: "world-id" };
  // Live mode without a proof: only accept nullifiers already proven this boot.
  return { ok: verifiedNullifiers.has(nullifier), nullifier, mode: "world-id" };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
/**
 * Resolve the tenant payout address. On Hedera, a contract transfer to an
 * address with NO existing account reverts — which would trap the deposit
 * until the timeout. So a custom payout target must exist on-chain first.
 */
async function resolvePayout(nullifier: string, tenantAddress?: string): Promise<string> {
  if (!tenantAddress) {
    const linked = nullifierWallet.get(nullifier);
    if (linked) return linked;                      // remembered from last time
    return Wallet.createRandom().address;           // demo throwaway
  }
  if (!isAddress(tenantAddress)) throw new Error("invalid payout address");
  const addr = getAddress(tenantAddress);
  if (network.startsWith("hedera")) {
    const net = network === "hedera-mainnet" ? "mainnet" : "testnet";
    const res = await fetch(`https://${net}.mirrornode.hedera.com/api/v1/accounts/${addr.toLowerCase()}`);
    if (!res.ok) {
      throw new Error(
        "that wallet has no Hedera account yet — open OculusVault once (it auto-creates on first receive) or fund it, then retry"
      );
    }
  }
  nullifierWallet.set(nullifier, addr); // link once — never ask this human again
  return addr;
}

function sanitizeCustomItems(raw: any): TemplateItem[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) throw new Error("1-8 items required");
  return raw.map((r: any, i: number) => {
    const name = String(r?.name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    // Neutralised before it can reach the vision prompt (see guards.ts).
    const desc = sanitizeForPrompt(r?.desc);
    if (!name || !desc) throw new Error(`item ${i + 1}: name and description are both required`);
    // The liveness challenge is chosen by the SERVER, never by the client: a
    // challenge the uploader picks is one an old photo can already satisfy.
    return { name, desc, nonce: generateLivenessNonce() };
  });
}

async function createDemoCheckout(nullifier: string, tenantAddress?: string, templateId?: string, customItems?: any, fresh = false, geoLock = false, timeLockMinutes = 30, brain?: "0g-compute" | "openai") {
  // one human, one live checkout — the World ID nullifier is the sybil key
  const tpl = customItems ? null : (templateById(templateId ?? "rental_checkout") ?? TEMPLATES[0]);
  const items = customItems ? sanitizeCustomItems(customItems) : tpl!.items;
  // Terms belong to the inspection DESIGNER: templates carry their own
  // geo/time/verifier; client-supplied values are honored only for custom
  // inspections (where the client IS the designer).
  if (tpl) {
    geoLock = tpl.geoLock ?? false;
    timeLockMinutes = tpl.timeLockMinutes ?? 30;
    brain = tpl.brain ?? (process.env.ZEROG_COMPUTE === "1" ? "0g-compute" : undefined);
  }
  const names = new Set(items.map((i) => i.name));
  if (names.size !== items.length) throw new Error("duplicate item names");

  // Resume exists so a page reload mid-checkout doesn't strand the case. But
  // when the human explicitly walked out of it, resuming would hand them back
  // items that already passed — and those can't be re-submitted (AlreadyPassed).
  const existing = fresh ? undefined : humanToCheckout.get(nullifier);
  if (existing && checkoutMeta.has(existing)) {
    const meta0 = checkoutMeta.get(existing)!;
    const c = await escrow.getFunction("getCheckout")(existing);
    // resume only if same template still in progress; else start fresh
    if (c.status === 2n && meta0.template === (tpl ? tpl.title : "Custom Inspection")) return describeCheckout(existing);
  }

  // Unpredictable: createCheckout is unauthenticated on-chain, so a guessable
  // id lets an attacker squat the checkout this tenant is about to fund.
  const id = newCheckoutId();
  const tenant = await resolvePayout(nullifier, tenantAddress);
  // HEDERA GOTCHA: inside Hedera's EVM, msg.value is in tinybar (8 decimals),
  // while the JSON-RPC relay takes tx value in 18-decimal weibar. So the
  // stored deposit must be tinybar-scaled on Hedera or the == check reverts.
  const isHedera = network.startsWith("hedera");
  const depositHbarWanted = tpl?.depositHbar ?? 2;
  // ── the assurance gate: your World ID tier caps how much we escrow ──
  const tier = tierOf(nullifier);
  const cap = TIER_CAP_HBAR[tier];
  if (depositHbarWanted > cap) {
    const need: Tier = depositHbarWanted <= TIER_CAP_HBAR.selfie ? "selfie" : "orb";
    throw new Error(
      `TIER_GATE:${need}:this ${depositHbarWanted} ℏ escrow exceeds your ${tier.toUpperCase()} tier cap of ${cap} ℏ — step up with ${need === "selfie" ? "Selfie Check" : "Orb verification"} to unlock it`
    );
  }
  const deposit = isHedera ? BigInt(depositHbarWanted) * 10n ** 8n : parseEther(String(depositHbarWanted));
  // time lock: the whole checkout must finish inside this window (on-chain deadline)
  const windowMin = Math.min(Math.max(Math.round(timeLockMinutes) || 30, 5), 120);
  // use CHAIN time, not wall time — dev chains (anvil) drift via evm_increaseTime
  const chainNow = (await provider.getBlock("latest"))!.timestamp;
  const deadline = chainNow + windowMin * 60;

  await (await escrow.getFunction("createCheckout")(id, tenant, deposit, deadline, items.map((i) => itemIdOf(i.name)))).wait();
  // demo: relayer funds the deposit on the tenant's behalf via direct call
  // (tx value always 18-dec through the RPC layer; Hedera relay converts)
  const txValue = isHedera ? parseEther(String(depositHbarWanted)) : deposit;
  await (await escrow.getFunction("deposit")(id, { value: txValue })).wait();

  // The liveness nonces aren't needed until the tenant submits their first
  // photo, which is >30s away — but on Hedera every tx costs ~5s of consensus,
  // so awaiting three of them here doubled the wait the human actually sees.
  // Commit them in the background instead; submitEvidence awaits this promise
  // before it reads a commitment, so the ordering guarantee is unchanged.
  // (commitNonce accepts Created OR Funded, so post-deposit is legal.)
  // Sends stay sequential: Hedera's relay rejects future-nonce txs outright
  // rather than queueing them the way geth does.
  const noncesReady = (async () => {
    for (const it of items) {
      await (await escrow.getFunction("commitNonce")(id, itemIdOf(it.name), keccak256(toUtf8Bytes(it.nonce)))).wait();
    }
  })();
  // keep the rejection from going unhandled; submitEvidence re-awaits and surfaces it
  noncesReady.catch((e) => console.error(`[api] checkout ${id} nonce commit failed —`, e?.message ?? e));

  // lifecycle audit trail (fire-and-forget): the case is born on the public record.
  // Descriptions travel as keccak hashes — provably fixed, never revealed.
  void emitHcsEvent("checkout_created", {
    checkoutId: id,
    template: tpl ? tpl.title : "Custom Inspection",
    escrow: await escrow.getAddress(),
    depositHbar: depositHbarWanted,
    geoLock,
    timeLockMinutes: windowMin,
    items: items.map((it) => ({ item: it.name, descHash: keccak256(toUtf8Bytes(it.desc)) })),
  });
  void noncesReady.then(() =>
    emitHcsEvent("nonces_committed", {
      checkoutId: id,
      nonces: items.map((it) => ({ item: it.name, nonceHash: keccak256(toUtf8Bytes(it.nonce)) })),
    })
  ).catch(() => {});

  humanToCheckout.set(nullifier, id);
  checkoutMeta.set(id, { items, tenant, template: tpl ? tpl.title : "Custom Inspection", icon: tpl ? tpl.icon : "🛠", geoLock, timeLockMinutes: windowMin, brain, noncesReady });
  console.log(`[api] checkout ${id} created for human ${nullifier.slice(0, 12)}… tenant=${tenant}`);
  return describeCheckout(id);
}

// ---------------------------------------------------------------------------
// Case archive — read back from HCS, not from our own memory
// ---------------------------------------------------------------------------
/**
 * The receipts sealed to HCS *are* the history: public, durable, and readable
 * by anyone holding the topic id — including after this process restarts with
 * empty maps. So the archive is a mirror-node read, not a database.
 *
 * Receipts run past the 1 KB HCS message cap (signatures are long), so they
 * arrive as numbered chunks that must be reassembled in order. A receipt whose
 * chunks straddle the page boundary is simply not whole yet, and is skipped
 * rather than shown half-parsed.
 */
let historyCache: { at: number; data: any[] } = { at: 0, data: [] };

async function readHistory(limit = 8): Promise<any[]> {
  const topicId = process.env.HCS_TOPIC_ID;
  if (!topicId) return [];
  if (Date.now() - historyCache.at < 15_000) return historyCache.data.slice(0, limit);

  const net = network === "hedera-mainnet" ? "mainnet" : "testnet";
  const url = `https://${net}.mirrornode.hedera.com/api/v1/topics/${topicId}/messages?limit=60&order=desc`;
  let body: any;
  try {
    const res = await fetch(url);
    if (!res.ok) return historyCache.data.slice(0, limit);
    body = await res.json();
  } catch {
    return historyCache.data.slice(0, limit); // mirror hiccup: serve what we had
  }

  const groups = new Map<string, any[]>();
  for (const m of body.messages ?? []) {
    const key = m.chunk_info?.initial_transaction_id?.transaction_valid_start ?? `seq-${m.sequence_number}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(m);
    else groups.set(key, [m]);
  }

  const out: any[] = [];
  for (const parts of groups.values()) {
    parts.sort((a, b) => (a.chunk_info?.number ?? 1) - (b.chunk_info?.number ?? 1));
    if (parts.length !== (parts[0].chunk_info?.total ?? 1)) continue;
    try {
      const blob = Buffer.concat(parts.map((p) => Buffer.from(p.message, "base64"))).toString("utf8");
      const r = JSON.parse(blob);
      if (r?.app !== "aivy-checkout") continue;
      out.push({
        sequence: parts[0].sequence_number,
        checkoutId: r.checkoutId,
        outcome: r.outcome,
        tenant: r.tenant,
        releaseTx: r.releaseTx,
        ts: r.ts,
        items: (r.items ?? []).map((i: any) => ({ item: i.item, verdict: i.verdict, tx: i.tx })),
      });
    } catch {
      // a malformed receipt is not worth failing the whole archive over
    }
  }
  out.sort((a, b) => b.sequence - a.sequence);
  historyCache = { at: Date.now(), data: out };
  return out.slice(0, limit);
}

async function describeCheckout(id: number) {
  const meta = checkoutMeta.get(id);
  const c = await escrow.getFunction("getCheckout")(id);
  const items = await Promise.all(
    (meta?.items ?? []).map(async (it) => ({
      name: it.name,
      description: it.desc,
      nonceInstruction: it.nonce,
      passed: await escrow.getFunction("isItemPassed")(id, itemIdOf(it.name)),
    }))
  );
  return {
    checkoutId: id,
    escrow: await escrow.getAddress(),
    tenant: meta?.tenant ?? c.tenant,
    deposit: c.deposit.toString(),
    depositHbar: Number(c.deposit) / (network.startsWith("hedera") ? 1e8 : 1e18),
    deadline: Number(c.deadline),
    status: ["None", "Created", "Funded", "Released", "Resolved"][Number(c.status)],
    template: meta?.template ?? "Inspection",
    templateIcon: meta?.icon ?? "▣",
    geoLock: meta?.geoLock ?? false,
    timeLockMinutes: meta?.timeLockMinutes ?? 30,
    verifierBrain: meta?.brain ?? (process.env.ZEROG_COMPUTE === "1" ? "0g-compute" : "openai"),
    network,
    hcsTopic: process.env.HCS_TOPIC_ID ?? null,
    items,
  };
}

async function submitEvidence(id: number, itemName: string, imageDataUrl: string, nullifier: string, geo?: { lat: number; lng: number; acc?: number }) {
  const meta = checkoutMeta.get(id);
  if (!meta) throw new Error("unknown checkout");
  if (humanToCheckout.get(nullifier) !== id) throw new Error("this human is not the tenant of this checkout");
  const item = meta.items.find((i) => i.name === itemName);
  if (!item) throw new Error("unknown item");
  if (meta.geoLock) {
    const ok = geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lng) && Math.abs(geo.lat) <= 90 && Math.abs(geo.lng) <= 180;
    if (!ok) throw new Error("geo-lock active: location is required with every capture (allow GPS and retry)");
  }

  // createDemoCheckout returns before the nonce commits land (see there);
  // this is the point where they must be on-chain.
  if (meta.noncesReady) await meta.noncesReady;

  // decode data URL -> tmp file
  const m = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(imageDataUrl ?? "");
  if (!m) throw new Error("imageDataUrl must be a base64 image data URL");
  // Don't relabel what we can't identify: an iPhone HEIC written to a .jpg
  // reaches the vision API as a corrupt JPEG and comes back as an opaque 400.
  // Fail here instead, with something the person holding the phone can act on.
  const EXT: Record<string, string> = {
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
    "image/webp": ".webp", "image/gif": ".gif",
  };
  const ext = EXT[m[1].toLowerCase()];
  if (!ext) {
    throw new Error(
      `photo format ${m[1]} isn't supported — shoot it with the camera button instead of picking from the library`
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "aivy-"));
  const imagePath = join(dir, `${itemName}${ext}`);
  writeFileSync(imagePath, Buffer.from(m[2], "base64"));

  const stored = await storeEvidence(imagePath);
  const verdict = await judge({
    itemName: item.name,
    itemDescription: item.desc,
    nonceInstruction: item.nonce,
    imagePath,
  }, meta.brain);

  const v: ItemVerdict = {
    checkoutId: BigInt(id),
    itemId: itemIdOf(item.name),
    verdict: verdict.pass,
    imageHash: stored.imageHash,
    nonceHash: keccak256(toUtf8Bytes(item.nonce)),
    deadline: BigInt((await provider.getBlock("latest"))!.timestamp + 300),
  };
  const sig = await signVerdict(relayerWallet, v);
  const tx = await escrow.getFunction("verifyItemAndRelease")(
    id,
    [v.checkoutId, v.itemId, v.verdict, v.imageHash, v.nonceHash, v.deadline],
    sig
  );
  const receipt = await tx.wait();

  const log = evidenceLog.get(id) ?? [];
  log.push({
    item: item.name,
    verdict: verdict.pass ? "PASS" : "FAIL",
    // which brain decided, and — when it was 0G Compute — whether the enclave
    // signature verified. This rides into the HCS receipt, so "our inference is
    // TEE-sealed" is something a reader can check rather than take on trust.
    brain: verdict.brain,
    teeVerified: verdict.teeVerified ?? null,
    computeModel: verdict.computeModel ?? null,
    imageHash: stored.imageHash,
    evidenceUri: stored.uri,
    signature: sig,
    tx: receipt?.hash,
  });
  evidenceLog.set(id, log);

  // per-item lifecycle event: verdict + evidence hash, consensus-ordered
  void emitHcsEvent("verdict_signed", {
    checkoutId: id,
    item: item.name,
    verdict: verdict.pass ? "PASS" : "FAIL",
    brain: verdict.brain,
    teeVerified: verdict.teeVerified ?? null,
    imageHash: stored.imageHash,
    storageRoot: stored.root ?? null,
    descHash: keccak256(toUtf8Bytes(item.desc)),
    geo: roundGeo(meta.geoLock && geo ? geo : null),
    tx: receipt?.hash,
  });

  const state = await describeCheckout(id);
  let hcsSeal = null;
  if (state.status === "Released") {
    hcsSeal = await sealToHcs(id, receipt?.hash);
  }
  return {
    item: item.name,
    verdict: verdict.pass ? "PASS" : "FAIL",
    conditionOk: verdict.conditionOk,
    nonceOk: verdict.nonceOk,
    reason: verdict.reason,
    brain: verdict.brain,
    imageHash: stored.imageHash,
    evidenceUri: stored.uri,
    storageRoot: stored.root ?? null,
    storageBackend: stored.backend,
    signature: sig,             // the verifier's secp256k1 signature over the verdict
    verifier: relayerWallet.address,
    txHash: receipt?.hash,
    verifiedAt: new Date().toISOString(),
    geo: meta.geoLock && geo ? { lat: geo.lat, lng: geo.lng, acc: geo.acc ?? null } : null,
    hcsSeal,
    checkout: state,
  };
}

// ---------------------------------------------------------------------------
// HCS sealing — the immutable receipt log (fire-and-forget on release)
// ---------------------------------------------------------------------------
// ── HCS lifecycle audit trail ───────────────────────────────────────
// Every stage of a checkout emits a small consensus-ordered event to the
// public topic: checkout_created -> nonce_committed -> verdict_signed (per
// item) -> escrow_released. Privacy: descriptions and GPS never go raw —
// descriptions as keccak hashes, geo rounded to ~1 km. Fail-soft: an HCS
// hiccup logs loudly and never blocks a settlement.
let hcsClientPromise: Promise<any> | null = null;
async function getHcsClient() {
  const topicId = process.env.HCS_TOPIC_ID;
  const opId = process.env.HEDERA_OPERATOR_ID;
  const opKey = process.env.HEDERA_OPERATOR_KEY;
  if (!topicId || !opId || !opKey) return null;
  if (!hcsClientPromise) {
    hcsClientPromise = (async () => {
      const { Client, PrivateKey } = await import("@hashgraph/sdk");
      return Client.forTestnet().setOperator(opId, PrivateKey.fromStringECDSA(opKey));
    })().catch((e) => { hcsClientPromise = null; throw e; });
  }
  return hcsClientPromise;
}

export async function emitHcsEvent(type: string, payload: Record<string, unknown>): Promise<{ topicId: string; sequence: string } | null> {
  const topicId = process.env.HCS_TOPIC_ID;
  try {
    const client = await getHcsClient();
    if (!client || !topicId) {
      console.warn(`[hcs] ⚠️  creds not set — event ${type} NOT sealed`);
      return null;
    }
    const { TopicMessageSubmitTransaction } = await import("@hashgraph/sdk");
    const tx = await new TopicMessageSubmitTransaction({
      topicId,
      message: JSON.stringify({ v: 1, app: "aivy-checkout", type, ts: new Date().toISOString(), ...payload }),
    }).execute(client);
    const rec = await tx.getReceipt(client);
    const seq = rec.topicSequenceNumber?.toString() ?? "";
    console.log(`[hcs] ✅ ${type} sealed seq ${seq}`);
    return { topicId, sequence: seq };
  } catch (e: any) {
    console.error(`[hcs] event ${type} failed:`, e?.message ?? e);
    return null;
  }
}

/** GPS rounded to 2 decimals ≈ 1.1 km — proves the area, not the doorstep. */
function roundGeo(geo?: { lat: number; lng: number } | null) {
  if (!geo) return undefined;
  return { lat: Math.round(geo.lat * 100) / 100, lng: Math.round(geo.lng * 100) / 100 };
}

async function sealToHcs(checkoutId: number, releaseTx: string | undefined) {
  const topicId = process.env.HCS_TOPIC_ID;
  const opId = process.env.HEDERA_OPERATOR_ID;
  const opKey = process.env.HEDERA_OPERATOR_KEY;
  if (!topicId || !opId || !opKey) {
    console.warn("[api] ⚠️  HCS creds not set — receipt NOT sealed (set HCS_TOPIC_ID/HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY)");
    return null;
  }
  try {
    const { Client, PrivateKey, TopicMessageSubmitTransaction } = await import("@hashgraph/sdk");
    const client = Client.forTestnet().setOperator(opId, PrivateKey.fromStringECDSA(opKey));
    const meta = checkoutMeta.get(checkoutId);
    const receipt = {
      v: 1,
      app: "aivy-checkout",
      checkoutId,
      escrow: await escrow.getAddress(),
      tenant: meta?.tenant,
      outcome: "RELEASED",
      releaseTx,
      items: evidenceLog.get(checkoutId) ?? [],
      ts: new Date().toISOString(),
    };
    const tx = await new TopicMessageSubmitTransaction({
      topicId,
      message: JSON.stringify(receipt),
    }).execute(client);
    const rec = await tx.getReceipt(client);
    client.close();
    const seq = rec.topicSequenceNumber?.toString();
    console.log(`[api] ✅ receipt sealed to HCS topic ${topicId} seq ${seq}`);
    return { topicId, sequence: seq };
  } catch (e) {
    console.error("[api] HCS seal failed:", e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function json(res: ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": process.env.CORS_ORIGIN ?? "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(s);
}

function readBody(req: IncomingMessage, maxBytes = 12 * 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) reject(new Error("body too large"));
      else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});
    if (path === "/api/health") {
      return json(res, 200, { ok: true, escrow: await escrow.getAddress(), rpc: RPC, network, hcsTopic: process.env.HCS_TOPIC_ID ?? null, worldId: process.env.WORLD_APP_ID ? "live" : "simulator", worldAppId: process.env.WORLD_APP_ID ?? null, worldAction: process.env.WORLD_ACTION ?? "aivy-checkout", selfieEnabled: SELFIE_ENABLED, worldRpId: process.env.WORLD_RP_ID ?? null, computeEnabled: process.env.ZEROG_COMPUTE === "1" });
    }
    // ── World ID 4.0 (Selfie Check beta) — active when WORLD_RP_ID is set ──
    if (path === "/api/world/rp-signature" && req.method === "POST") {
      const rpKey = process.env.WORLD_RP_SIGNING_KEY;
      if (!process.env.WORLD_RP_ID || !rpKey) return json(res, 503, { error: "World ID 4.0 not configured (WORLD_RP_ID / WORLD_RP_SIGNING_KEY)" });
      const body = await readBody(req);
      const { signRequest } = await import("@worldcoin/idkit-core/signing");
      const { sig, nonce, createdAt, expiresAt } = signRequest({
        signingKeyHex: rpKey,
        action: String(body.action ?? process.env.WORLD_ACTION ?? "aivy-checkout"),
      });
      return json(res, 200, { sig, nonce, created_at: createdAt, expires_at: expiresAt, rp_id: process.env.WORLD_RP_ID });
    }
    if (path === "/api/world/verify-v4" && req.method === "POST") {
      const rpId = process.env.WORLD_RP_ID;
      if (!rpId) return json(res, 503, { error: "World ID 4.0 not configured" });
      const body = await readBody(req);
      const vres = await fetch(`https://developer.world.org/api/v4/verify/${rpId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body.idkitResponse),
      });
      const vj: any = await vres.json().catch(() => ({}));
      if (!vres.ok) {
        console.error("[api] v4 verify failed:", vres.status, JSON.stringify(vj).slice(0, 300));
        return json(res, 400, { error: "World ID verification failed", detail: vj });
      }
      // VENUE-TODO: confirm exact response shape from /api/v4/verify — we
      // defensively look for the nullifier + credential type in common spots.
      const r = body.idkitResponse ?? {};
      const nullifier: string =
        vj.nullifier_hash ?? vj.nullifier ?? r.nullifier_hash ?? r.nullifier ??
        (Array.isArray(r.proofs) ? r.proofs[0]?.nullifier_hash : undefined) ?? "";
      // SECURITY: tier derives ONLY from World-verified material. vj is the
      // verifier's response (trusted); idkitResponse identifiers are usable
      // only BECAUSE verification of that exact payload just succeeded.
      // The client-supplied credentialHint is deliberately ignored.
      const identifiers: string[] = [
        ...(Array.isArray(vj.results) ? vj.results.map((x: any) => x?.identifier) : []),
        ...(Array.isArray(vj.responses) ? vj.responses.map((x: any) => x?.identifier) : []),
        ...(Array.isArray(r.results) ? r.results.map((x: any) => x?.identifier) : []),
        ...(Array.isArray(r.responses) ? r.responses.map((x: any) => x?.identifier) : []),
        vj.credential_type, vj.verification_level, r.credential_type, r.verification_level,
      ].filter(Boolean).map((x: any) => String(x).toLowerCase());
      const credential =
        identifiers.find((i) => i.includes("selfie")) ??
        identifiers.find((i) => i.includes("orb") || i.includes("human") || i.includes("passport") || i.includes("document")) ??
        identifiers[0] ?? "device";
      if (!nullifier) return json(res, 400, { error: "verified but no nullifier found — inspect payload", detail: vj });
      verifiedNullifiers.add(nullifier);
      // selfie_check / selfie -> selfie tier; orb / proof_of_human -> orb
      const level = credential.includes("selfie") ? "selfie" : (credential.includes("orb") || credential.includes("human")) ? "orb" : "device";
      recordTier(nullifier, level);
      const tier = tierOf(nullifier);
      console.log(`[api] ✅ v4 verified nullifier=${nullifier.slice(0, 14)}… credential=${credential} tier=${tier}`);
      return json(res, 200, {
        ok: true, nullifier, mode: "world-id-v4", credential, tier,
        capHbar: TIER_CAP_HBAR[tier],
        linkedWallet: nullifierWallet.get(nullifier) ?? null,
        selfieEnabled: SELFIE_ENABLED,
      });
    }
    if (path === "/api/verify-human" && req.method === "POST") {
      const out = await verifyHuman(await readBody(req));
      const tier = out.ok ? tierOf(out.nullifier) : "device";
      return json(res, out.ok ? 200 : 400, {
        ...out,
        linkedWallet: out.ok ? nullifierWallet.get(out.nullifier) ?? null : null,
        tier,
        capHbar: TIER_CAP_HBAR[tier],
        selfieEnabled: SELFIE_ENABLED,
      });
    }
    if (path === "/api/history" && req.method === "GET") {
      return json(res, 200, { topic: process.env.HCS_TOPIC_ID ?? null, receipts: await readHistory() });
    }
    if (path === "/api/templates" && req.method === "GET") {
      return json(res, 200, { templates: TEMPLATES.map(({ id, title, payer, blurb, icon, items, depositHbar, geoLock, timeLockMinutes, brain }) => ({ id, title, payer, blurb, icon, itemCount: items.length, depositHbar: depositHbar ?? 2, geoLock: geoLock ?? false, timeLockMinutes: timeLockMinutes ?? 30, brain: brain ?? (process.env.ZEROG_COMPUTE === "1" ? "0g-compute" : "openai") })) });
    }
    if (path === "/api/demo/checkout" && req.method === "POST") {
      const body = await readBody(req);
      const human = await verifyHuman(body);
      if (!human.ok) return json(res, 401, { error: "personhood verification failed" });
      return json(res, 200, await createDemoCheckout(
        human.nullifier,
        body.tenantAddress ? String(body.tenantAddress) : undefined,
        body.templateId ? String(body.templateId) : undefined,
        body.customItems,
        Boolean(body.fresh),
        Boolean(body.geoLock),
        Number(body.timeLockMinutes) || 30,
        body.brain === "openai" || body.brain === "0g-compute" ? body.brain : undefined
      ));
    }
    const mGet = /^\/api\/checkout\/(\d+)$/.exec(path);
    if (mGet && req.method === "GET") {
      return json(res, 200, await describeCheckout(Number(mGet[1])));
    }
    const mEv = /^\/api\/checkout\/(\d+)\/evidence$/.exec(path);
    if (mEv && req.method === "POST") {
      const body = await readBody(req);
      const human = await verifyHuman(body);
      if (!human.ok) return json(res, 401, { error: "personhood verification failed" });
      const out = await submitEvidence(Number(mEv[1]), String(body.itemName), String(body.imageDataUrl), human.nullifier, body.geo);
      return json(res, 200, out);
    }
    return json(res, 404, { error: "not found" });
  } catch (e: any) {
    console.error(`[api] ${req.method} ${path} ->`, e?.message ?? e);
    return json(res, 400, { error: String(e?.message ?? e) });
  }
});

boot().then(() => {
  server.listen(PORT, "127.0.0.1", () => console.log(`[api] listening on 127.0.0.1:${PORT}`));
});

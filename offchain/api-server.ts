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

const PORT = Number(process.env.PORT ?? 8791);
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const RELAYER_PK =
  process.env.RELAYER_PRIVATE_KEY ??
  // anvil pk[1] — DEV ONLY; a real deployment must set RELAYER_PRIVATE_KEY
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

type TemplateItem = { name: string; desc: string; nonce: string };
type Template = { id: string; title: string; payer: string; blurb: string; icon: string; items: TemplateItem[] };

// The platform: one escrow + evidence + AI-verdict engine, many inspection
// templates. Anything physical that two parties dispute at a handover.
const TEMPLATES: Template[] = [
  {
    id: "rental_checkout",
    title: "Rental Checkout",
    payer: "hosts & property managers",
    blurb: "Tenant proves the place is fine; deposit releases itself.",
    icon: "🏠",
    items: [
      // Two items, not three: this gets demoed live and repeatedly, so every
      // item is another chance for venue wifi or a bad angle to derail it.
      // Two still shows the progression and the auto-release on the last pass.
      // Both objects exist in every venue on earth, and the two nonces use
      // different mechanics — one placed prop, one bare hand — so losing the
      // pen costs one item instead of the whole demo.
      // Condition wording has to be satisfiable by the actual object. "no
      // chips, burns or deep scratches" on a venue table fails honestly —
      // every venue table has all three — and a verifier told to fail when
      // uncertain will keep failing it. Describe structural damage, not wear.
      { name: "chair", desc: "chair with an intact seat and backrest, no cracks or broken legs", nonce: "lay a yellow pen across the seat of the chair" },
      { name: "laptop", desc: "laptop open, screen intact and casing not cracked", nonce: "rest one open palm flat beside the trackpad" },
    ],
  },
  {
    id: "vehicle_return",
    title: "Vehicle Return",
    payer: "rental fleets & insurers",
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
let nextCheckoutId = Math.floor(Date.now() / 1000) % 1_000_000; // unique-ish per boot

// sybil gate: one human -> one active demo checkout
const humanToCheckout = new Map<string, number>();
// single-login UX: first wallet a human provides is remembered forever
const nullifierWallet = new Map<string, string>();
// nullifiers that passed a REAL World ID proof this boot (live mode only)
const verifiedNullifiers = new Set<string>();
const checkoutMeta = new Map<
  number,
  { items: TemplateItem[]; tenant: string; template: string; icon: string; noncesReady?: Promise<void> }
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
    const ok = res.ok && j.success !== false;
    if (ok) verifiedNullifiers.add(body.proof.nullifier_hash);
    return { ok, nullifier: body.proof.nullifier_hash, mode: "world-id" };
  }
  const nullifier = String(body?.nullifier ?? "").slice(0, 128);
  if (!nullifier) return { ok: false, nullifier: "", mode: appId ? "world-id" : "simulator" };
  if (appId) {
    // Live mode without a proof: only accept nullifiers already proven this boot.
    return { ok: verifiedNullifiers.has(nullifier), nullifier, mode: "world-id" };
  }
  console.warn(`[api] ⚠️  WORLD_APP_ID not set — SIMULATED personhood for nullifier ${nullifier.slice(0, 18)}…`);
  return { ok: true, nullifier, mode: "simulator" };
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
    const desc = String(r?.desc ?? "").trim().slice(0, 160);
    const nonce = String(r?.nonce ?? "").trim().slice(0, 160);
    if (!name || !desc || !nonce) throw new Error(`item ${i + 1}: name, description and liveness challenge are all required`);
    return { name, desc, nonce };
  });
}

async function createDemoCheckout(nullifier: string, tenantAddress?: string, templateId?: string, customItems?: any, fresh = false) {
  // one human, one live checkout — the World ID nullifier is the sybil key
  const tpl = customItems ? null : (templateById(templateId ?? "rental_checkout") ?? TEMPLATES[0]);
  const items = customItems ? sanitizeCustomItems(customItems) : tpl!.items;
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

  const id = nextCheckoutId++;
  const tenant = await resolvePayout(nullifier, tenantAddress);
  // HEDERA GOTCHA: inside Hedera's EVM, msg.value is in tinybar (8 decimals),
  // while the JSON-RPC relay takes tx value in 18-decimal weibar. So the
  // stored deposit must be tinybar-scaled on Hedera or the == check reverts.
  const isHedera = network.startsWith("hedera");
  const deposit = isHedera ? 2n * 10n ** 8n : parseEther("2");
  // use CHAIN time, not wall time — dev chains (anvil) drift via evm_increaseTime
  const chainNow = (await provider.getBlock("latest"))!.timestamp;
  const deadline = chainNow + 30 * 60;

  await (await escrow.getFunction("createCheckout")(id, tenant, deposit, deadline, items.map((i) => itemIdOf(i.name)))).wait();
  // demo: relayer funds the deposit on the tenant's behalf via direct call
  // (tx value always 18-dec through the RPC layer; Hedera relay converts)
  const txValue = isHedera ? parseEther("2") : deposit;
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

  humanToCheckout.set(nullifier, id);
  checkoutMeta.set(id, { items, tenant, template: tpl ? tpl.title : "Custom Inspection", icon: tpl ? tpl.icon : "🛠", noncesReady });
  console.log(`[api] checkout ${id} created for human ${nullifier.slice(0, 12)}… tenant=${tenant}`);
  return describeCheckout(id);
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
    network,
    hcsTopic: process.env.HCS_TOPIC_ID ?? null,
    items,
  };
}

async function submitEvidence(id: number, itemName: string, imageDataUrl: string, nullifier: string) {
  const meta = checkoutMeta.get(id);
  if (!meta) throw new Error("unknown checkout");
  if (humanToCheckout.get(nullifier) !== id) throw new Error("this human is not the tenant of this checkout");
  const item = meta.items.find((i) => i.name === itemName);
  if (!item) throw new Error("unknown item");

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
  });

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
    imageHash: stored.imageHash,
    evidenceUri: stored.uri,
    signature: sig,
    tx: receipt?.hash,
  });
  evidenceLog.set(id, log);

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
    hcsSeal,
    checkout: state,
  };
}

// ---------------------------------------------------------------------------
// HCS sealing — the immutable receipt log (fire-and-forget on release)
// ---------------------------------------------------------------------------
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
      return json(res, 200, { ok: true, escrow: await escrow.getAddress(), rpc: RPC, network, hcsTopic: process.env.HCS_TOPIC_ID ?? null, worldId: process.env.WORLD_APP_ID ? "live" : "simulator", worldAppId: process.env.WORLD_APP_ID ?? null, worldAction: process.env.WORLD_ACTION ?? "aivy-checkout" });
    }
    if (path === "/api/verify-human" && req.method === "POST") {
      const out = await verifyHuman(await readBody(req));
      return json(res, out.ok ? 200 : 400, { ...out, linkedWallet: out.ok ? nullifierWallet.get(out.nullifier) ?? null : null });
    }
    if (path === "/api/templates" && req.method === "GET") {
      return json(res, 200, { templates: TEMPLATES.map(({ id, title, payer, blurb, icon, items }) => ({ id, title, payer, blurb, icon, itemCount: items.length })) });
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
        Boolean(body.fresh)
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
      const out = await submitEvidence(Number(mEv[1]), String(body.itemName), String(body.imageDataUrl), human.nullifier);
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

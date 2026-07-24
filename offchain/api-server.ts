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

const ITEMS = [
  { name: "espresso_machine", desc: "espresso machine on the kitchen counter, undamaged", nonce: "place a blue pen next to the espresso machine" },
  { name: "tv", desc: "living room TV with intact screen", nonce: "hold two fingers in front of the tv screen" },
  { name: "bedroom_door", desc: "bedroom door with no holes or dents", nonce: "press an open palm flat on the bedroom door" },
];

const provider = new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
const relayerWallet = new Wallet(RELAYER_PK, provider);
const relayer = new NonceManager(relayerWallet);

let escrow: Contract;
let network = "local"; // "hedera-testnet" | "hedera-mainnet" | "local"
let nextCheckoutId = Math.floor(Date.now() / 1000) % 1_000_000; // unique-ish per boot

// sybil gate: one human -> one active demo checkout
const humanToCheckout = new Map<string, number>();
const checkoutMeta = new Map<number, { items: typeof ITEMS; tenant: string }>();

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
    return { ok: res.ok && j.success !== false, nullifier: body.proof.nullifier_hash, mode: "world-id" };
  }
  // Simulator mode: accept a client nullifier, loudly labeled.
  const nullifier = String(body?.nullifier ?? "").slice(0, 128);
  if (!nullifier) return { ok: false, nullifier: "", mode: "simulator" };
  console.warn(`[api] ⚠️  WORLD_APP_ID not set — SIMULATED personhood for nullifier ${nullifier.slice(0, 18)}…`);
  return { ok: true, nullifier, mode: "simulator" };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
async function createDemoCheckout(nullifier: string) {
  // one human, one live checkout — the World ID nullifier is the sybil key
  const existing = humanToCheckout.get(nullifier);
  if (existing && checkoutMeta.has(existing)) {
    const c = await escrow.getFunction("getCheckout")(existing);
    if (c.status === 2n) return describeCheckout(existing); // still in progress
  }

  const id = nextCheckoutId++;
  const tenant = Wallet.createRandom().address; // demo payout target
  // HEDERA GOTCHA: inside Hedera's EVM, msg.value is in tinybar (8 decimals),
  // while the JSON-RPC relay takes tx value in 18-decimal weibar. So the
  // stored deposit must be tinybar-scaled on Hedera or the == check reverts.
  const isHedera = network.startsWith("hedera");
  const deposit = isHedera ? 2n * 10n ** 8n : parseEther("2");
  // use CHAIN time, not wall time — dev chains (anvil) drift via evm_increaseTime
  const chainNow = (await provider.getBlock("latest"))!.timestamp;
  const deadline = chainNow + 30 * 60;

  await (await escrow.getFunction("createCheckout")(id, tenant, deposit, deadline, ITEMS.map((i) => itemIdOf(i.name)))).wait();
  for (const it of ITEMS) {
    await (await escrow.getFunction("commitNonce")(id, itemIdOf(it.name), keccak256(toUtf8Bytes(it.nonce)))).wait();
  }
  // demo: relayer funds the deposit on the tenant's behalf via direct call
  // (tx value always 18-dec through the RPC layer; Hedera relay converts)
  const txValue = isHedera ? parseEther("2") : deposit;
  await (await escrow.getFunction("deposit")(id, { value: txValue })).wait();

  humanToCheckout.set(nullifier, id);
  checkoutMeta.set(id, { items: ITEMS, tenant });
  console.log(`[api] checkout ${id} created for human ${nullifier.slice(0, 12)}… tenant=${tenant}`);
  return describeCheckout(id);
}

async function describeCheckout(id: number) {
  const meta = checkoutMeta.get(id);
  const c = await escrow.getFunction("getCheckout")(id);
  const items = await Promise.all(
    (meta?.items ?? ITEMS).map(async (it) => ({
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

  // decode data URL -> tmp file
  const m = /^data:(image\/\w+);base64,(.+)$/s.exec(imageDataUrl ?? "");
  if (!m) throw new Error("imageDataUrl must be a base64 image data URL");
  const ext = m[1] === "image/png" ? ".png" : ".jpg";
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

  const state = await describeCheckout(id);
  return {
    item: item.name,
    verdict: verdict.pass ? "PASS" : "FAIL",
    conditionOk: verdict.conditionOk,
    nonceOk: verdict.nonceOk,
    reason: verdict.reason,
    brain: verdict.brain,
    imageHash: stored.imageHash,
    evidenceUri: stored.uri,
    storageBackend: stored.backend,
    signature: sig,             // the verifier's secp256k1 signature over the verdict
    verifier: relayerWallet.address,
    txHash: receipt?.hash,
    verifiedAt: new Date().toISOString(),
    checkout: state,
  };
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
      return json(res, 200, { ok: true, escrow: await escrow.getAddress(), rpc: RPC, network, hcsTopic: process.env.HCS_TOPIC_ID ?? null, worldId: process.env.WORLD_APP_ID ? "live" : "simulator" });
    }
    if (path === "/api/verify-human" && req.method === "POST") {
      const out = await verifyHuman(await readBody(req));
      return json(res, out.ok ? 200 : 400, out);
    }
    if (path === "/api/demo/checkout" && req.method === "POST") {
      const body = await readBody(req);
      const human = await verifyHuman(body);
      if (!human.ok) return json(res, 401, { error: "personhood verification failed" });
      return json(res, 200, await createDemoCheckout(human.nullifier));
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

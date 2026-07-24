/**
 * End-to-end demo — Stage 3 proof.
 *
 * Runs the ENTIRE Aivy Checkout loop against a local Anvil chain:
 *   deploy -> createCheckout(3 items) -> commit nonces -> tenant deposits
 *   -> capture evidence -> store (0G or local) -> vision verdict -> sign
 *   -> verifyItemAndRelease x3 -> deposit released to tenant
 * then the FAILURE path on a second checkout: a "damaged" photo yields a
 * signed FAIL verdict -> deposit stays locked -> deadline passes ->
 * resolveTimeout pays the host.
 *
 * Prereqs: anvil running (default http://127.0.0.1:8545), `forge build` done.
 * Run: npm run e2e
 */
import { Contract, ContractFactory, JsonRpcProvider, NonceManager, Wallet, keccak256, toUtf8Bytes, parseEther } from "ethers";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { itemIdOf, signVerdict, ItemVerdict } from "./payload.js";
import { storeEvidence } from "./storage-0g.js";
import { judge } from "./vision-agent.js";

const RPC = process.env.E2E_RPC_URL ?? "http://127.0.0.1:8545";

// anvil's default funded accounts
const PK_DEPLOYER_RELAYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d45d95e6f00";
const PK_HOST = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PK_TENANT = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

const ITEMS = [
  { name: "espresso_machine", desc: "espresso machine on the kitchen counter", nonce: "place a blue pen next to the espresso machine" },
  { name: "tv", desc: "living room TV, screen intact", nonce: "hold two fingers in front of the tv" },
  { name: "bedroom_door", desc: "bedroom door, no holes or dents", nonce: "press an open palm flat on the bedroom door" },
];

function fakePhoto(dir: string, label: string): string {
  // Stand-in evidence blobs (unique bytes per label). At the venue these are
  // real camera captures from the TG Mini App.
  mkdirSync(dir, { recursive: true });
  const p = `${dir}/${label}.jpg`;
  writeFileSync(p, Buffer.from(`FAKEJPEG:${label}:${label.length * 7919}`));
  return p;
}

async function main() {
  // cacheTimeout -1: disable ethers' 250ms latest-block cache so balance reads
  // right after a tx see the new state (bit us in the timeout payout check).
  const provider = new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
  const relayerWallet = new Wallet(PK_DEPLOYER_RELAYER, provider);
  const relayer = new NonceManager(relayerWallet) as unknown as Wallet & NonceManager;
  (relayer as any).address = relayerWallet.address;
  (relayer as any).signMessage = relayerWallet.signMessage.bind(relayerWallet);
  const host = new NonceManager(new Wallet(PK_HOST, provider));
  const tenant = new NonceManager(new Wallet(PK_TENANT, provider));
  (host as any).address = await host.getAddress();
  (tenant as any).address = await tenant.getAddress();

  // Fund the actors directly (anvil cheatcode) — independent of anvil's mnemonic.
  for (const w of [relayer, host, tenant]) {
    await provider.send("anvil_setBalance", [w.address, "0x21E19E0C9BAB2400000"]); // 10,000 ETH
  }

  // -- deploy ---------------------------------------------------------------
  const artifact = JSON.parse(
    readFileSync(new URL("../out/CheckoutEscrow.sol/CheckoutEscrow.json", import.meta.url), "utf8")
  );
  const escrow = (await (async () => {
    const f = new ContractFactory(artifact.abi, artifact.bytecode.object, relayer);
    const c = await f.deploy(relayer.address); // relayer key = verifier (baseline)
    await c.waitForDeployment();
    return new Contract(await c.getAddress(), artifact.abi, relayer);
  })()) as Contract;
  console.log(`\n[1] deployed CheckoutEscrow at ${await escrow.getAddress()} (verifier=${relayer.address})`);

  const deposit = parseEther("200");
  const now = (await provider.getBlock("latest"))!.timestamp;
  const deadline = now + 3600;
  const itemIds = ITEMS.map((i) => itemIdOf(i.name));

  // ==========================================================================
  // HAPPY PATH — checkout #1
  // ==========================================================================
  console.log("\n=== HAPPY PATH (checkout 1) ===");
  await (await escrow.connect(host).getFunction("createCheckout")(1n, tenant.address, deposit, deadline, itemIds)).wait();
  for (const item of ITEMS) {
    await (await escrow.connect(host).getFunction("commitNonce")(1n, itemIdOf(item.name), keccak256(toUtf8Bytes(item.nonce)))).wait();
  }
  console.log("[2] checkout created, 3 nonces committed on-chain BEFORE capture");

  await (await escrow.connect(tenant).getFunction("deposit")(1n, { value: deposit })).wait();
  console.log(`[3] tenant deposited 200 HBAR-equivalent (escrow balance: ${await provider.getBalance(escrow.getAddress())})`);

  const tenantBefore = await provider.getBalance(tenant.address);

  for (const item of ITEMS) {
    const photo = fakePhoto("/tmp/aivy-e2e", `${item.name}-clean`);
    const stored = await storeEvidence(photo);
    const verdict = await judge({ itemName: item.name, itemDescription: item.desc, nonceInstruction: item.nonce, imagePath: photo });
    console.log(`[4] ${item.name}: stored(${stored.backend}) hash=${stored.imageHash.slice(0, 14)}… vision(${verdict.brain})=${verdict.pass ? "PASS" : "FAIL"}`);

    const v: ItemVerdict = {
      checkoutId: 1n,
      itemId: itemIdOf(item.name),
      verdict: verdict.pass,
      imageHash: stored.imageHash,
      nonceHash: keccak256(toUtf8Bytes(item.nonce)),
      deadline: BigInt(now + 600),
    };
    const sig = await signVerdict(relayer, v);
    await (await escrow.getFunction("verifyItemAndRelease")(1n, [v.checkoutId, v.itemId, v.verdict, v.imageHash, v.nonceHash, v.deadline], sig)).wait();
  }

  const c1 = await escrow.getFunction("getCheckout")(1n);
  const tenantAfter = await provider.getBalance(tenant.address);
  console.log(`[5] ✅ status=${c1.status} (3=Released) — tenant received ${(tenantAfter - tenantBefore) / 10n ** 18n} ETH-units of deposit`);
  if (c1.status !== 3n) throw new Error("happy path did not release!");

  // ==========================================================================
  // FAILURE PATH — checkout #2: damaged item, then timeout -> host
  // ==========================================================================
  console.log("\n=== FAILURE PATH (checkout 2) ===");
  const deadline2 = (await provider.getBlock("latest"))!.timestamp + 3600;
  await (await escrow.connect(host).getFunction("createCheckout")(2n, tenant.address, deposit, deadline2, [itemIdOf("tv")])).wait();
  await (await escrow.connect(host).getFunction("commitNonce")(2n, itemIdOf("tv"), keccak256(toUtf8Bytes(ITEMS[1].nonce)))).wait();
  await (await escrow.connect(tenant).getFunction("deposit")(2n, { value: deposit })).wait();

  const badPhoto = fakePhoto("/tmp/aivy-e2e", "tv-damaged"); // mock brain fails on "damaged"
  const storedBad = await storeEvidence(badPhoto);
  const badVerdict = await judge({ itemName: "tv", itemDescription: ITEMS[1].desc, nonceInstruction: ITEMS[1].nonce, imagePath: badPhoto });
  console.log(`[6] tv: vision(${badVerdict.brain})=${badVerdict.pass ? "PASS" : "FAIL"} — "${badVerdict.reason}"`);

  const vBad: ItemVerdict = {
    checkoutId: 2n,
    itemId: itemIdOf("tv"),
    verdict: badVerdict.pass, // false
    imageHash: storedBad.imageHash,
    nonceHash: keccak256(toUtf8Bytes(ITEMS[1].nonce)),
    deadline: BigInt(deadline2),
  };
  await (await escrow.getFunction("verifyItemAndRelease")(2n, [vBad.checkoutId, vBad.itemId, vBad.verdict, vBad.imageHash, vBad.nonceHash, vBad.deadline], await signVerdict(relayer, vBad))).wait();

  let c2 = await escrow.getFunction("getCheckout")(2n);
  console.log(`[7] ❌ FAIL verdict recorded on-chain; status=${c2.status} (2=Funded — deposit still LOCKED, tenant NOT paid)`);
  if (c2.status !== 2n) throw new Error("failure path should stay Funded!");

  // fast-forward past the deadline, host resolves
  await provider.send("evm_increaseTime", [3700]);
  await provider.send("evm_mine", []);
  const hostAddr = await host.getAddress();
  const hostBefore = await provider.getBalance(hostAddr);
  await (await escrow.getFunction("resolveTimeout")(2n)).wait();
  const hostAfter = await provider.getBalance(hostAddr);
  c2 = await escrow.getFunction("getCheckout")(2n);
  console.log(`[8] ⏰ deadline passed -> resolveTimeout: status=${c2.status} (4=Resolved) — host received ${(hostAfter - hostBefore) / 10n ** 18n} units`);

  console.log("\n🎉 E2E COMPLETE — full loop proven locally: escrow, nonce-commit, evidence hash, AI verdict, signed release, rejection, timeout resolution.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

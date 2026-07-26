/**
 * Probe the real 0G Compute path before wiring it into the verdict pipeline.
 * Text first (cheap), then a real evidence image. Prints every step so a
 * failure tells us WHICH part is unsupported.
 */
const fs = require("fs");
const { ethers } = require("ethers");

const env = Object.fromEntries(
  fs.readFileSync("/opt/aivy-checkout/.env", "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

const PROVIDER = process.argv[2] || "0xa48f01287233509FD694a22Bf840225062E67836"; // qwen2.5-omni-7b
const IMAGE = process.argv[3] || null;

(async () => {
  const { createZGComputeNetworkBroker } = await import("@0gfoundation/0g-compute-ts-sdk");
  const rpc = env.ZEROG_COMPUTE_RPC_URL || env.ZEROG_RPC_URL || "https://evmrpc-testnet.0g.ai";
  const wallet = new ethers.Wallet(env.ZEROG_PRIVATE_KEY, new ethers.JsonRpcProvider(rpc));
  console.log("wallet:", wallet.address);

  const broker = await createZGComputeNetworkBroker(wallet);

  // 1. ledger
  let ledger = null;
  try { ledger = await broker.ledger.getLedger(); } catch (e) { console.log("no ledger yet:", e.message?.slice(0, 90)); }
  if (!ledger) {
    console.log("creating ledger with 0.01 OG (leaving the rest for 0G Storage gas)…");
    await broker.ledger.addLedger(0.01);
    ledger = await broker.ledger.getLedger();
  }
  console.log("ledger balance:", ethers.formatEther(ledger.totalBalance ?? ledger[1] ?? 0n), "OG");

  // 2. acknowledge provider (one-time, on-chain)
  try { await broker.inference.acknowledgeProviderSigner(PROVIDER); console.log("provider acknowledged"); }
  catch (e) { console.log("acknowledge:", e.message?.slice(0, 120)); }

  // 3. service metadata
  const meta = await broker.inference.getServiceMetadata(PROVIDER);
  console.log("endpoint:", meta.endpoint, "\nmodel:", meta.model);

  async function ask(messages, label) {
    const body = { messages, model: meta.model };
    const content = JSON.stringify(messages);
    const headers = await broker.inference.getRequestHeaders(PROVIDER, content);
    const t0 = Date.now();
    const res = await fetch(`${meta.endpoint}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(`\n[${label}] HTTP ${res.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (!res.ok) { console.log(text.slice(0, 400)); return null; }
    const j = JSON.parse(text);
    const answer = j.choices?.[0]?.message?.content;
    console.log(`[${label}] answer:`, String(answer).slice(0, 300));
    const resKey = res.headers.get("zg-res-key") || j.id; // header, NOT chat id (see compute-0g.ts)
    const valid = await broker.inference.processResponse(PROVIDER, resKey, String(answer));
    console.log(`[${label}] TEE verified:`, valid);
    return answer;
  }

  await ask([{ role: "user", content: "Reply with exactly: ALIVE" }], "text");

  if (IMAGE) {
    const b64 = fs.readFileSync(IMAGE).toString("base64");
    console.log(`\nimage: ${IMAGE} (${(b64.length / 1024).toFixed(0)} KB base64)`);
    await ask([{
      role: "user",
      content: [
        { type: "text", text: "Answer strict JSON {\"seen\":\"<3 words>\"} describing this photo." },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
      ],
    }], "image");
  }
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });

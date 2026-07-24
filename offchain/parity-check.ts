/**
 * Cross-language parity: sign an ItemVerdict in TS, recompute the digest the
 * way the Solidity contract does, and confirm ethers recovers the same signer.
 * This is the piece that de-risks the RELAYER: what the Node service signs is
 * exactly what the Hedera contract will accept.
 *
 * Run: npm i && npm run parity
 */
import { Wallet, getBytes, verifyMessage } from "ethers";
import { ItemVerdict, itemIdOf, structHash, signVerdict } from "./payload.js";

async function main() {
  const wallet = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const v: ItemVerdict = {
    checkoutId: 1n,
    itemId: itemIdOf("espresso_machine"),
    verdict: true,
    imageHash: itemIdOf("0g://blob/abc"),
    nonceHash: itemIdOf("blue pen next to espresso machine"),
    deadline: 1_900_000_000n,
  };

  const sig = await signVerdict(wallet, v);
  const recovered = verifyMessage(getBytes(structHash(v)), sig);

  console.log("signer   :", wallet.address);
  console.log("recovered:", recovered);
  console.log("structHash:", structHash(v));
  if (recovered.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error("PARITY FAILED — TS signature will not recover on-chain.");
  }
  console.log("\n✅ PARITY OK — relayer-signed verdicts will verify in the Hedera contract.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

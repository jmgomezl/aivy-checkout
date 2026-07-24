/**
 * Deploy CheckoutEscrow to Hedera testnet (or any EVM RPC).
 * The verifier is set to the relayer wallet's address (baseline). Swap to the
 * 0G TEE enclave address later with escrow.setVerifier(...).
 *
 * Usage:
 *   export HEDERA_RPC_URL=https://testnet.hashio.io/api
 *   export RELAYER_PRIVATE_KEY=0x...
 *   forge build && npm run deploy
 */
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";
import { readFileSync } from "node:fs";

async function main() {
  const rpc = process.env.HEDERA_RPC_URL;
  const pk = process.env.RELAYER_PRIVATE_KEY;
  if (!rpc || !pk) throw new Error("Set HEDERA_RPC_URL and RELAYER_PRIVATE_KEY.");

  const artifact = JSON.parse(
    readFileSync(new URL("../out/CheckoutEscrow.sol/CheckoutEscrow.json", import.meta.url), "utf8")
  );

  const provider = new JsonRpcProvider(rpc);
  const wallet = new Wallet(pk, provider);
  console.log("deployer/verifier:", wallet.address);

  const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, wallet);
  const escrow = await factory.deploy(wallet.address);
  await escrow.waitForDeployment();

  const addr = await escrow.getAddress();
  console.log("\nCheckoutEscrow deployed:", addr);
  console.log("export ESCROW_ADDRESS=" + addr);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

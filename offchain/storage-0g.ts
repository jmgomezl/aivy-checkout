/**
 * Evidence storage — Stage 3.
 *
 * Primary: 0G Storage via @0glabs/0g-ts-sdk (set ZEROG_RPC_URL, ZEROG_INDEXER_URL,
 * ZEROG_PRIVATE_KEY and install the SDK at the venue: npm i @0glabs/0g-ts-sdk).
 * Fallback: local content-addressed store under offchain/evidence/ — same
 * keccak256 hash goes on-chain either way, so the contract flow is identical
 * and the swap to real 0G is invisible to everything downstream.
 */
import { keccak256 } from "ethers";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { extname } from "node:path";

export interface StoredEvidence {
  imageHash: string;   // 0x keccak256 of the blob — what the TEE/relayer signs
  uri: string;         // 0g root hash URI, or file:// fallback
  backend: "0g" | "local";
}

export async function storeEvidence(imagePath: string): Promise<StoredEvidence> {
  const blob = readFileSync(imagePath);
  const imageHash = keccak256(blob);

  if (process.env.ZEROG_INDEXER_URL && process.env.ZEROG_PRIVATE_KEY) {
    try {
      return await storeOn0g(imagePath, imageHash);
    } catch (e) {
      console.warn("[storage] 0G upload failed, falling back to local:", e);
    }
  }

  // Local content-addressed fallback — loud, never silent.
  const dir = new URL("./evidence/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const dest = new URL(`./evidence/${imageHash}${extname(imagePath)}`, import.meta.url);
  copyFileSync(imagePath, dest);
  console.warn(
    `[storage] ⚠️  0G creds not set (ZEROG_INDEXER_URL/ZEROG_PRIVATE_KEY) — evidence stored ` +
      `LOCALLY at ${dest.pathname}. Same keccak hash goes on-chain; swap to 0G is drop-in.`
  );
  return { imageHash, uri: dest.toString(), backend: "local" };
}

async function storeOn0g(imagePath: string, imageHash: string): Promise<StoredEvidence> {
  // Lazy import: SDK only needed when creds are present.
  // API per @0glabs/0g-ts-sdk README — verify at the venue with probe-0g.ts.
  const zg = await import("@0glabs/0g-ts-sdk" as string);
  const { ethers } = await import("ethers");

  const provider = new ethers.JsonRpcProvider(process.env.ZEROG_RPC_URL);
  const signer = new ethers.Wallet(process.env.ZEROG_PRIVATE_KEY!, provider);
  const indexer = new zg.Indexer(process.env.ZEROG_INDEXER_URL!);

  const file = await zg.ZgFile.fromFilePath(imagePath);
  const [tree, treeErr] = await file.merkleTree();
  if (treeErr) throw treeErr;

  const [tx, uploadErr] = await indexer.upload(file, process.env.ZEROG_RPC_URL!, signer);
  if (uploadErr) throw uploadErr;
  await file.close();

  const root = tree!.rootHash();
  console.log(`[storage] ✅ uploaded to 0G Storage root=${root} tx=${tx}`);
  return { imageHash, uri: `0g://${root}`, backend: "0g" };
}

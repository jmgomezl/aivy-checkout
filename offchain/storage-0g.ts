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
  uri: string;         // public download URL (0G indexer) or file:// fallback
  root?: string;       // 0G merkle root (when backend === "0g")
  backend: "0g" | "local";
}

export async function storeEvidence(imagePath: string): Promise<StoredEvidence> {
  const blob = readFileSync(imagePath);
  const imageHash = keccak256(blob);

  if (process.env.ZEROG_PRIVATE_KEY) {
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
  // NOTE: the maintained SDK is @0gfoundation/0g-storage-ts-sdk — the old
  // @0glabs/0g-ts-sdk (0.3.x) targets a retired flow contract and its
  // submit tx reverts on Galileo (chain 16602). Cost us an hour; keep this note.
  const zg = await import("@0gfoundation/0g-storage-ts-sdk" as string);
  const { ethers } = await import("ethers");

  const rpc = process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
  const indexerUrl = process.env.ZEROG_INDEXER_URL ?? "https://indexer-storage-testnet-turbo.0g.ai";
  const provider = new ethers.JsonRpcProvider(rpc);
  const signer = new ethers.Wallet(process.env.ZEROG_PRIVATE_KEY!, provider);
  const indexer = new zg.Indexer(indexerUrl);

  const file = await zg.ZgFile.fromFilePath(imagePath);
  const [res, uploadErr] = await indexer.upload(file, rpc, signer);
  await file.close();
  if (uploadErr) throw uploadErr;

  const root = res.rootHash;
  console.log(`[storage] ✅ 0G Storage root=${root} tx=${res.txHash} seq=${res.txSeq}`);
  // the indexer serves blobs publicly by root — receipt links resolve for anyone
  return { imageHash, uri: `${indexerUrl}/file?root=${root}`, root, backend: "0g" };
}

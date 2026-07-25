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
  backend: "0g" | "0g-pending" | "local";
}

/**
 * 0G finalization is not on the critical path. A blob can spend a minute in
 * "available, but not finalized yet" retries, and this call sits in front of
 * the vision verdict — so a slow segment stalls the whole item until nginx
 * gives up at 120s. Since the keccak hash that goes on-chain is the same
 * whether the bytes live on 0G or on disk, waiting past this budget buys
 * nothing: let the upload finish in the background and keep the human moving.
 */
const ZEROG_BUDGET_MS = Number(process.env.ZEROG_TIMEOUT_MS ?? 12_000);

function withBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([p.then((v) => { clearTimeout(timer); return v; }), budget]);
}

export async function storeEvidence(imagePath: string): Promise<StoredEvidence> {
  const blob = readFileSync(imagePath);
  const imageHash = keccak256(blob);

  if (process.env.ZEROG_PRIVATE_KEY) {
    const upload = storeOn0g(imagePath, imageHash);
    // the upload outlives this request either way; log where it ends up
    upload.then(
      (r) => console.log(`[storage] 0G finalized late root=${r.root}`),
      (e) => console.warn("[storage] 0G upload failed:", e?.message ?? e)
    );
    try {
      const landed = await withBudget(upload, ZEROG_BUDGET_MS);
      if (landed) return landed;
      console.warn(
        `[storage] ⏱ 0G still finalizing after ${ZEROG_BUDGET_MS}ms — serving the local copy ` +
          `and letting the upload finish in the background. Same keccak hash goes on-chain.`
      );
      return { imageHash, uri: localCopy(imagePath, imageHash), backend: "0g-pending" };
    } catch (e: any) {
      console.warn("[storage] 0G upload failed, falling back to local:", e?.message ?? e);
    }
  }

  // Local content-addressed fallback — loud, never silent.
  const uri = localCopy(imagePath, imageHash);
  console.warn(
    `[storage] ⚠️  0G creds not set (ZEROG_INDEXER_URL/ZEROG_PRIVATE_KEY) — evidence stored ` +
      `LOCALLY at ${uri}. Same keccak hash goes on-chain; swap to 0G is drop-in.`
  );
  return { imageHash, uri, backend: "local" };
}

/** Content-addressed copy on disk. The hash is the same one 0G would serve. */
function localCopy(imagePath: string, imageHash: string): string {
  const dir = new URL("./evidence/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const dest = new URL(`./evidence/${imageHash}${extname(imagePath)}`, import.meta.url);
  copyFileSync(imagePath, dest);
  return dest.toString();
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

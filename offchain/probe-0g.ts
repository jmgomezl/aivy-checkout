/**
 * Step 1, second half — probe the REAL 0G Compute output BEFORE trusting the
 * TEE path. The Foundry test already proved the Hedera side (ecrecover works).
 * The open question is what 0G actually returns:
 *
 *   Outcome A — a signature over the output by a stable enclave secp256k1 key
 *               -> UPGRADE: set authorizedSigner = that enclave address.
 *   Outcome B — an Intel TDX attestation quote (verify off-chain vs Intel PCS)
 *               -> BASELINE: relayer verifies the quote, then re-signs the
 *                  verdict with its own secp256k1 key. Same contract, same
 *                  ecrecover — nothing downstream changes.
 *
 * TRIPWIRE: if this does not clearly yield Outcome A within the 2-hour box,
 * ship Outcome B (relayer-signed) and frame the TEE as roadmap. Do not let this
 * block Step 2.
 */
import { ethers } from "ethers";

async function probe() {
  const endpoint = process.env.ZEROG_COMPUTE_URL ?? "";
  if (!endpoint) {
    console.log("Set ZEROG_COMPUTE_URL to probe. Skipping (assume Outcome B / relayer-signed).");
    return;
  }

  // Adjust to the real 0G Compute inference call once its SDK/API is confirmed.
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "aivy-vision-verify", imageRef: "0g://demo" }),
  });
  const body = await res.json();
  console.log("RAW 0G RESPONSE >>>", JSON.stringify(body, null, 2));

  // Decision heuristic — inspect the shape:
  const hasSig = !!(body.signature || body.sig);
  const hasQuote = !!(body.attestation || body.quote || body.tdx);
  if (hasSig) {
    console.log("=> OUTCOME A: signature present. Verify it recovers a stable address:");
    try {
      const digest = body.digest ?? body.messageHash;
      const recovered = ethers.verifyMessage(ethers.getBytes(digest), body.signature ?? body.sig);
      console.log("   recovered enclave signer:", recovered);
      console.log("   ACTION: setAuthorizedSigner(recovered) and go TEE-signed.");
    } catch (e) {
      console.log("   signature did not recover cleanly -> treat as Outcome B.", e);
    }
  } else if (hasQuote) {
    console.log("=> OUTCOME B: TDX quote, not an on-chain-verifiable signature.");
    console.log("   ACTION: relayer verifies quote off-chain, re-signs verdict. Ship baseline.");
  } else {
    console.log("=> UNKNOWN shape -> default to Outcome B (relayer-signed) and move on.");
  }
}

probe().catch((e) => {
  console.error("probe failed -> default to Outcome B (relayer-signed).", e);
});

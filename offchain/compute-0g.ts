/**
 * 0G Compute — TEE-sealed inference for the verdict that moves the money.
 *
 * The whole product rests on one judgement: does this photo show an undamaged
 * item, staged with the challenge that was committed on-chain before the photo
 * existed? Running that judgement on a normal API means the verdict is only as
 * trustworthy as whoever operates it. 0G Compute runs it inside a TEE and signs
 * the response with the enclave key, so the answer is verifiable rather than
 * merely asserted — `processResponse` checks that signature client-side.
 *
 * Deliberately fail-soft: every path returns null instead of throwing, and the
 * caller falls back to the conventional vision brain. A settlement demo must
 * not go down because a provider is slow. What you lose on fallback is the TEE
 * guarantee, which is why the verdict records which brain actually decided —
 * see `teeVerified` on the receipt, not a claim in a README.
 *
 * Enable with ZEROG_COMPUTE=1. Requires ZEROG_PRIVATE_KEY with a funded ledger
 * (3 OG minimum at the time of writing — `npm run probe:compute` validates it).
 */
import type { VisionInput, VisionVerdict } from "./vision-agent.js";

// qwen2.5-omni-7b — the multimodal service on the network; the other listed
// provider is image-editing and cannot judge. Override if the network changes.
const DEFAULT_PROVIDER = "0xa48f01287233509FD694a22Bf840225062E67836";
const BUDGET_MS = Number(process.env.ZEROG_COMPUTE_TIMEOUT_MS ?? 25_000);

let brokerPromise: Promise<any> | null = null;
let acknowledged = false;

async function getBroker(): Promise<any> {
  if (!brokerPromise) {
    brokerPromise = (async () => {
      const { ethers } = await import("ethers");
      const zg: any = await import("@0gfoundation/0g-compute-ts-sdk" as string);
      const rpc = process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
      const wallet = new ethers.Wallet(process.env.ZEROG_PRIVATE_KEY!, new ethers.JsonRpcProvider(rpc));
      return zg.createZGComputeNetworkBroker(wallet);
    })().catch((e) => {
      brokerPromise = null; // let a later request retry rather than poisoning the cache
      throw e;
    });
  }
  return brokerPromise;
}

/**
 * Tuned for a 7B multimodal model, which behaves differently from a frontier
 * one. Two changes earn their keep, both found by testing against real evidence:
 *
 *  - "seen" first. Forcing the model to state what is in frame before judging
 *    grounds the verdict; without it, it judged from the instruction text and
 *    missed a palm occupying half the photo.
 *  - Presence, not position. "when uncertain, fail" plus literal wording made it
 *    reject a hand resting ON the laptop because the instruction said "beside
 *    the trackpad". Frontier models read that as intent; a 7B reads it as spec.
 *
 * Verified against controls: a palm-on-laptop photo passes, a chair photo with
 * no pen fails. Loosening presence-vs-position did not make it a rubber stamp.
 */
const SYSTEM = `You verify photo evidence that releases a security deposit. Return strict JSON only:
{"seen":"what is actually in the foreground, one sentence","conditionOk":bool,"nonceOk":bool,"reason":"one sentence"}
conditionOk: true if the described item is present and free of structural damage. Ignore normal wear.
nonceOk: true if the required object or gesture from the liveness instruction is clearly present and deliberate. Judge presence, not exact position: "beside the trackpad" is satisfied by a hand resting anywhere on the laptop. false if it is absent, or if the photo looks generated or re-photographed from a screen.`;

function parseVerdict(raw: string): { conditionOk: boolean; nonceOk: boolean; reason: string } | null {
  // models wrap JSON in prose or fences often enough that a bare parse is naive
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const j = JSON.parse(match[0]);
    if (typeof j.conditionOk !== "boolean" || typeof j.nonceOk !== "boolean") return null;
    return { conditionOk: j.conditionOk, nonceOk: j.nonceOk, reason: String(j.reason ?? "").slice(0, 400) };
  } catch {
    return null;
  }
}

export async function judgeOn0gCompute(
  input: VisionInput,
  imageBase64: string,
  mediaType: string
): Promise<VisionVerdict | null> {
  if (process.env.ZEROG_COMPUTE !== "1" || !process.env.ZEROG_PRIVATE_KEY) return null;
  const provider = process.env.ZEROG_COMPUTE_PROVIDER ?? DEFAULT_PROVIDER;

  const attempt = (async (): Promise<VisionVerdict | null> => {
    const broker = await getBroker();

    // one-time on-chain handshake; harmless to repeat, but it costs a tx
    if (!acknowledged) {
      try {
        await broker.inference.acknowledgeProviderSigner(provider);
      } catch (e: any) {
        if (!/already acknowledged/i.test(e?.message ?? "")) throw e;
      }
      acknowledged = true;
    }

    const meta = await broker.inference.getServiceMetadata(provider);
    const messages = [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Item: ${input.itemName}\nExpected condition: ${input.itemDescription}\n` +
              `Liveness instruction that must be visibly satisfied: ${input.nonceInstruction}`,
          },
          { type: "image_url", image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
        ],
      },
    ];

    const content = JSON.stringify(messages);
    const headers = await broker.inference.getRequestHeaders(provider, content);
    const res = await fetch(`${meta.endpoint}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: meta.model, messages }),
    });
    if (!res.ok) {
      console.warn(`[0g-compute] provider returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }

    // The signature is filed under the provider's own response key, NOT the
    // chat id in the body. Passing body.id gets "chat_id_not_found" and the
    // whole verification silently degrades — cost an hour to find.
    const resKey = res.headers.get("zg-res-key") ?? undefined;
    const body: any = await res.json();
    const answer = String(body.choices?.[0]?.message?.content ?? "");
    const parsed = parseVerdict(answer);
    if (!parsed) {
      console.warn(`[0g-compute] unparseable verdict: ${answer.slice(0, 160)}`);
      return null;
    }

    // The point of the exercise: the enclave signed this response, and this is
    // where we check it. A false/null result still yields a usable verdict, so
    // record it rather than discarding the inference.
    let teeVerified: boolean | null = null;
    try {
      teeVerified = await broker.inference.processResponse(provider, resKey, answer);
    } catch (e: any) {
      console.warn("[0g-compute] signature verification errored:", e?.message ?? e);
    }

    console.log(
      `[0g-compute] ${input.itemName} condition=${parsed.conditionOk} nonce=${parsed.nonceOk} ` +
        `tee=${teeVerified} model=${meta.model}`
    );
    return {
      pass: parsed.conditionOk && parsed.nonceOk,
      conditionOk: parsed.conditionOk,
      nonceOk: parsed.nonceOk,
      reason: parsed.reason,
      brain: "0g-compute",
      teeVerified: teeVerified === true,
      computeProvider: provider,
      computeModel: meta.model,
    };
  })();

  // a slow provider must never become a stalled settlement
  const budget = new Promise<null>((resolve) => setTimeout(() => resolve(null), BUDGET_MS));
  try {
    const out = await Promise.race([attempt, budget]);
    if (!out) console.warn(`[0g-compute] no verdict within ${BUDGET_MS}ms — falling back`);
    return out;
  } catch (e: any) {
    console.warn("[0g-compute] failed, falling back:", e?.message ?? e);
    return null;
  }
}

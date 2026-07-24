/**
 * Aivy Vision Agent — Stage 3.
 *
 * Given a checkout item, the liveness nonce instruction, and the photo, decide:
 *   (A) is the item in acceptable condition?
 *   (B) is the physical liveness nonce visibly satisfied?
 * PASS only if both hold. The caller (relayer or 0G TEE) signs the verdict.
 *
 * Brains, in order of preference:
 *   1. 0G Compute (Outcome A of probe-0g.ts) — the enclave runs this same
 *      prompt and signs the output itself. Wire via ZEROG_COMPUTE_URL later.
 *   2. Claude vision via the Anthropic SDK (ANTHROPIC_API_KEY) — baseline.
 *   3. Deterministic mock (no key) — filename containing "damaged", "fail" or
 *      "nononce" fails; everything else passes. Keeps the E2E demo runnable
 *      offline and gives the failure path something real to reject.
 */
import { readFileSync } from "node:fs";
import { extname, basename } from "node:path";

export interface VisionInput {
  itemName: string;        // e.g. "espresso_machine"
  itemDescription: string; // what the host expects, e.g. "black DeLonghi espresso machine on kitchen counter"
  nonceInstruction: string; // e.g. "place a blue pen next to the espresso machine"
  imagePath: string;
}

export interface VisionVerdict {
  pass: boolean;
  conditionOk: boolean;
  nonceOk: boolean;
  reason: string;
  brain: "0g-compute" | "claude" | "mock";
}

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    conditionOk: {
      type: "boolean",
      description: "true only if the item appears present and undamaged",
    },
    nonceOk: {
      type: "boolean",
      description: "true only if the physical liveness instruction is clearly satisfied in the image",
    },
    reason: { type: "string", description: "one-sentence justification citing visible evidence" },
  },
  required: ["conditionOk", "nonceOk", "reason"],
  additionalProperties: false,
} as const;

const MEDIA: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export async function judge(input: VisionInput): Promise<VisionVerdict> {
  if (process.env.ANTHROPIC_API_KEY) return judgeWithClaude(input);
  return judgeMock(input);
}

async function judgeWithClaude(input: VisionInput): Promise<VisionVerdict> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();

  const mediaType = MEDIA[extname(input.imagePath).toLowerCase()] ?? "image/jpeg";
  const imageData = readFileSync(input.imagePath).toString("base64");

  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    system:
      "You are Aivy Inspect's evidence verifier for rental checkouts. You are adversarial by " +
      "default: the uploader is financially motivated to hide damage and to reuse old photos. " +
      "Only report conditionOk=true if the described item is clearly present and shows no damage. " +
      "Only report nonceOk=true if the physical liveness instruction is unambiguously satisfied " +
      "in THIS image. If the image looks AI-generated, edited, re-photographed from a screen, or " +
      "the nonce is missing/ambiguous, fail the corresponding check. When uncertain, fail.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType as "image/jpeg", data: imageData },
          },
          {
            type: "text",
            text:
              `Item under inspection: ${input.itemName}\n` +
              `Expected: ${input.itemDescription}\n` +
              `Liveness instruction the tenant was given: "${input.nonceInstruction}"\n\n` +
              `Assess condition and nonce compliance.`,
          },
        ],
      },
    ],
    output_config: {
      format: { type: "json_schema", schema: VERDICT_SCHEMA },
    },
  });

  if (response.stop_reason === "refusal") {
    return { pass: false, conditionOk: false, nonceOk: false, reason: "verifier refused", brain: "claude" };
  }
  const text = response.content.find((b) => b.type === "text");
  const parsed = JSON.parse(text && "text" in text ? text.text : "{}");
  const pass = Boolean(parsed.conditionOk && parsed.nonceOk);
  return { pass, conditionOk: !!parsed.conditionOk, nonceOk: !!parsed.nonceOk, reason: String(parsed.reason ?? ""), brain: "claude" };
}

function judgeMock(input: VisionInput): VisionVerdict {
  // Filename OR content markers fail — lets API-driven demos exercise the
  // rejection path (upload any file containing the text "damaged").
  const name = basename(input.imagePath).toLowerCase();
  let content = "";
  try { content = readFileSync(input.imagePath).toString("latin1", 0, 4096).toLowerCase(); } catch {}
  const blob = name + " " + content;
  const conditionOk = !blob.includes("damaged") && !blob.includes("fail");
  const nonceOk = !blob.includes("nononce");
  console.warn(
    "[vision] ⚠️  ANTHROPIC_API_KEY not set — using deterministic MOCK verdict " +
      `(filename heuristics) for ${name}. Set the key for real vision judging.`
  );
  return {
    pass: conditionOk && nonceOk,
    conditionOk,
    nonceOk,
    reason: `mock: filename-based (${name})`,
    brain: "mock",
  };
}

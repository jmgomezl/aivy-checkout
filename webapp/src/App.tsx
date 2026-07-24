import { useCallback, useEffect, useState } from "react";

/**
 * Aivy Checkout — tenant mini app (Stage 4).
 * Flow: verify personhood (World ID / simulator) -> start checkout ->
 * per-item: read the liveness instruction, capture a photo, submit ->
 * AI verdict + on-chain tx per item -> all pass = deposit released.
 * Runs inside Telegram (WebApp SDK present) or any browser.
 */

type Item = { name: string; description: string; nonceInstruction: string; passed: boolean };
type Checkout = {
  checkoutId: number;
  escrow: string;
  tenant: string;
  deposit: string;
  depositHbar: number;
  status: string;
  network: string;
  hcsTopic: string | null;
  items: Item[];
};
type EvidenceResult = {
  item: string;
  verdict: "PASS" | "FAIL";
  reason: string;
  brain: string;
  imageHash: string;
  evidenceUri: string;
  signature: string;
  verifier: string;
  txHash?: string;
  verifiedAt: string;
  storageBackend: string;
  checkout: Checkout;
};

const tg = (window as any).Telegram?.WebApp;

function useNullifier(): string {
  // Simulator personhood: stable per device. Replaced by the real IDKit
  // nullifier_hash when WORLD_APP_ID is configured server-side.
  const [n] = useState(() => {
    const k = "aivy:nullifier";
    let v = localStorage.getItem(k);
    if (!v) {
      v = "sim_" + crypto.randomUUID().replace(/-/g, "");
      localStorage.setItem(k, v);
    }
    return v;
  });
  return n;
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j as T;
}

function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(f);
  });
}

const ITEM_EMOJI: Record<string, string> = { espresso_machine: "☕", tv: "📺", bedroom_door: "🚪" };


// ---------------------------------------------------------------------------
// The Cryptographic Receipt — the invisible chain/AI actions as one artifact.
// ---------------------------------------------------------------------------
function explorerBase(network: string): string | null {
  if (network === "hedera-testnet") return "https://hashscan.io/testnet";
  if (network === "hedera-mainnet") return "https://hashscan.io/mainnet";
  return null; // local dev chain — hashes shown, no explorer
}

function Hash({ value, href, chars = 14 }: { value: string; href?: string | null; chars?: number }) {
  const short = value.length > chars ? value.slice(0, chars) + "…" : value;
  return href ? (
    <a className="hashlink mono" href={href} target="_blank" rel="noreferrer" title={value}>
      {short} ↗
    </a>
  ) : (
    <span className="hashlink mono" title={value + " (local chain — explorer link appears on Hedera testnet)"}>
      {short}
    </span>
  );
}

function Receipt({
  checkout,
  results,
  thumbs,
  releasedAt,
  onClose,
}: {
  checkout: Checkout;
  results: Record<string, EvidenceResult>;
  thumbs: Record<string, string>;
  releasedAt: Date;
  onClose: () => void;
}) {
  const exp = explorerBase(checkout.network);
  const when = new Intl.DateTimeFormat("en-US", {
    month: "long", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(releasedAt);
  const finalTx = Object.values(results).map((r) => r.txHash).filter(Boolean).pop();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="receipt" onClick={(e) => e.stopPropagation()}>
        <div className="receipt-head">
          <div className="receipt-title">
            ✅ CHECKOUT COMPLETE
            <span className="receipt-sub">
              Deposit of {checkout.depositHbar.toFixed(0)} ℏ released
            </span>
          </div>
          <div className="receipt-time">{when}</div>
        </div>

        {checkout.items.map((item) => {
          const r = results[item.name];
          if (!r) return null;
          const cidHref = r.evidenceUri.startsWith("http") || r.evidenceUri.startsWith("0g://gateway")
            ? r.evidenceUri : null;
          return (
            <div className="receipt-block" key={item.name}>
              <div className="receipt-block-title">
                {ITEM_EMOJI[item.name] ?? "📦"} EVIDENCE — {item.name.replace(/_/g, " ")}
              </div>
              <div className="receipt-row">
                {thumbs[item.name] && <img className="thumb" src={thumbs[item.name]} alt={item.name} />}
                <div className="grow">
                  <div className="kv">
                    <span>{r.storageBackend === "0g" ? "0G Storage root" : "Evidence hash (0G pending)"}</span>
                    <Hash value={r.storageBackend === "0g" ? r.evidenceUri.replace("0g://", "") : r.imageHash} href={cidHref} chars={18} />
                  </div>
                  <div className="kv">
                    <span>AI verdict</span>
                    <b className="passtext">PASS (undamaged, liveness nonce detected)</b>
                  </div>
                  <div className="kv">
                    <span>Verifier signature</span>
                    <Hash value={r.signature} chars={14} />
                  </div>
                  {r.txHash && (
                    <div className="kv">
                      <span>On-chain verdict tx</span>
                      <Hash value={r.txHash} href={exp ? `${exp}/transaction/${r.txHash}` : null} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        <div className="receipt-block">
          <div className="receipt-block-title">⛓ SETTLEMENT</div>
          <div className="kv">
            <span>Hedera escrow contract</span>
            <Hash value={checkout.escrow} href={exp ? `${exp}/contract/${checkout.escrow}` : null} />
          </div>
          {finalTx && (
            <div className="kv">
              <span>Release transaction</span>
              <Hash value={finalTx} href={exp ? `${exp}/transaction/${finalTx}` : null} />
            </div>
          )}
          <div className="kv">
            <span>HCS receipt topic</span>
            {checkout.hcsTopic ? (
              <Hash value={checkout.hcsTopic} href={exp ? `${exp}/topic/${checkout.hcsTopic}` : null} chars={20} />
            ) : (
              <span className="mono muted tiny">pending — set HCS_TOPIC_ID</span>
            )}
          </div>
          <div className="kv">
            <span>Paid to</span>
            <Hash value={checkout.tenant} href={exp ? `${exp}/account/${checkout.tenant}` : null} />
          </div>
        </div>

        <p className="tiny muted center receipt-foot">
          Every field above is independently verifiable: the evidence hash is committed in the
          verdict the verifier signed, the contract checked that signature with ecrecover before
          releasing funds, and the receipt is sealed to Hedera Consensus Service.
        </p>
        <button className="primary" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

export default function App() {
  const nullifier = useNullifier();
  const [verified, setVerified] = useState(false);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, EvidenceResult>>({});
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [showReceipt, setShowReceipt] = useState(false);
  const [releasedAt, setReleasedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string>("");
  const [health, setHealth] = useState<{ worldId: string } | null>(null);

  useEffect(() => {
    tg?.ready?.();
    tg?.expand?.();
    api<{ worldId: string }>("/api/health").then(setHealth).catch(() => {});
  }, []);

  const verify = useCallback(async () => {
    setError("");
    try {
      await api("/api/verify-human", { nullifier });
      setVerified(true);
      tg?.HapticFeedback?.notificationOccurred?.("success");
    } catch (e: any) {
      setError(e.message);
    }
  }, [nullifier]);

  const start = useCallback(async () => {
    setError("");
    try {
      setCheckout(await api<Checkout>("/api/demo/checkout", { nullifier }));
    } catch (e: any) {
      setError(e.message);
    }
  }, [nullifier]);

  const submit = useCallback(
    async (item: Item, file: File) => {
      if (!checkout) return;
      setBusyItem(item.name);
      setError("");
      try {
        const imageDataUrl = await fileToDataUrl(file);
        setThumbs((t) => ({ ...t, [item.name]: imageDataUrl }));
        const out = await api<EvidenceResult>(`/api/checkout/${checkout.checkoutId}/evidence`, {
          nullifier,
          itemName: item.name,
          imageDataUrl,
        });
        setResults((r) => ({ ...r, [item.name]: out }));
        setCheckout(out.checkout);
        if (out.checkout.status === "Released") {
          setReleasedAt(new Date());
          setShowReceipt(true);
        }
        tg?.HapticFeedback?.notificationOccurred?.(out.verdict === "PASS" ? "success" : "error");
      } catch (e: any) {
        setError(e.message);
      } finally {
        setBusyItem(null);
      }
    },
    [checkout, nullifier]
  );

  const released = checkout?.status === "Released";
  const passedCount = checkout?.items.filter((i) => i.passed).length ?? 0;

  return (
    <div className="wrap">
      <header>
        <div className="logo">🔍 Aivy Checkout</div>
        <div className="tag">AI-verified checkout receipts on Hedera · 0G · World ID</div>
      </header>

      {!verified && (
        <section className="card center">
          <h2>Prove you're a unique human</h2>
          <p className="muted">
            One human, one checkout. Your World ID nullifier is the sybil-resistance key — no
            documents, no doxxing.
          </p>
          <button className="primary" onClick={verify}>
            {health?.worldId === "live" ? "Verify with World ID" : "Verify (World ID Simulator)"}
          </button>
          {health?.worldId !== "live" && (
            <p className="tiny muted">Simulator mode — set WORLD_APP_ID server-side to go live.</p>
          )}
        </section>
      )}

      {verified && !checkout && (
        <section className="card center">
          <h2>✅ Human verified</h2>
          <p className="muted">
            Start your apartment checkout. The host escrowed your deposit on-chain; pass every
            checklist item and it releases to you <b>instantly</b>.
          </p>
          <button className="primary" onClick={start}>
            Start checkout
          </button>
        </section>
      )}

      {checkout && (
        <>
          <section className={`card status ${released ? "ok" : ""}`}>
            <div>
              <b>Checkout #{checkout.checkoutId}</b> · deposit{" "}
              {checkout.depositHbar.toFixed(0)} ℏ · {passedCount}/{checkout.items.length}{" "}
              items
            </div>
            <div className={`pill ${released ? "ok" : ""}`}>{checkout.status}</div>
          </section>

          {released && (
            <section className="card ok center">
              <h2>🎉 Deposit released!</h2>
              <p className="muted">
                Every item passed AI verification. The escrow paid your wallet the moment the last
                signed verdict landed on-chain.
              </p>
              <p className="tiny mono">tenant: {checkout.tenant}</p>
              <button className="primary" onClick={() => setShowReceipt(true)}>
                🧾 View cryptographic receipt
              </button>
            </section>
          )}

          {showReceipt && released && (
            <Receipt
              checkout={checkout}
              results={results}
              thumbs={thumbs}
              releasedAt={releasedAt ?? new Date()}
              onClose={() => setShowReceipt(false)}
            />
          )}

          {checkout.items.map((item) => {
            const r = results[item.name];
            return (
              <section key={item.name} className={`card item ${item.passed ? "ok" : r?.verdict === "FAIL" ? "bad" : ""}`}>
                <div className="row">
                  <div className="emoji">{ITEM_EMOJI[item.name] ?? "📦"}</div>
                  <div className="grow">
                    <b>{item.name.replace(/_/g, " ")}</b>
                    <div className="muted tiny">{item.description}</div>
                  </div>
                  <div className="pill">{item.passed ? "PASSED ✓" : r?.verdict === "FAIL" ? "FAILED ✗" : "PENDING"}</div>
                </div>

                {!item.passed && (
                  <>
                    <div className="nonce">
                      🎲 Liveness challenge: <b>{item.nonceInstruction}</b>
                    </div>
                    <label className={`capture ${busyItem === item.name ? "busy" : ""}`}>
                      {busyItem === item.name ? "⏳ storing → AI verifying → signing → on-chain…" : "📷 Capture evidence"}
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        disabled={busyItem !== null}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) submit(item, f);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </>
                )}

                {r && (
                  <div className="result tiny mono">
                    <div>verdict: {r.verdict} ({r.brain}) — {r.reason}</div>
                    <div>evidence: {r.imageHash.slice(0, 22)}… ({r.storageBackend})</div>
                    {r.txHash && <div>tx: {r.txHash.slice(0, 22)}…</div>}
                  </div>
                )}
              </section>
            );
          })}
        </>
      )}

      {error && <div className="error">⚠ {error}</div>}

      <footer className="tiny muted center">
        escrow: contract-verified verdicts (ecrecover) · evidence hashed on-chain · receipts sealed
        to HCS
      </footer>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { IDKitWidget, VerificationLevel, type ISuccessResult } from "@worldcoin/idkit";

/**
 * Aivy Checkout — tenant mini app.
 * Design language: "Evidence Lab" — dark forensic terminal; the finale is a
 * cream PAPER RECEIPT that prints out of the dark UI. All pipeline logic is
 * unchanged: verify personhood -> checkout -> per-item liveness capture ->
 * AI verdict -> signed on-chain release -> HCS-sealed receipt.
 */

type Item = { name: string; description: string; nonceInstruction: string; passed: boolean };
type Checkout = {
  checkoutId: number;
  escrow: string;
  tenant: string;
  deposit: string;
  depositHbar: number;
  status: string;
  template: string;
  templateIcon: string;
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
  hcsSeal?: { topicId: string; sequence: string } | null;
  checkout: Checkout;
};

const tg = (window as any).Telegram?.WebApp;

function useNullifier(): [string, (n: string) => void] {
  const [n, setN] = useState(() => {
    const k = "aivy:nullifier";
    let v = localStorage.getItem(k);
    if (!v) {
      v = "sim_" + crypto.randomUUID().replace(/-/g, "");
      localStorage.setItem(k, v);
    }
    return v;
  });
  return [n, setN];
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

const ITEM_ICON: Record<string, string> = {
  espresso_machine: "☕", tv: "📺", bedroom_door: "🚪",
  front_bumper: "🚗", driver_side: "🪞", dashboard: "🎛",
  parcel_intact: "📦", label_visible: "🏷", product_facing: "🛒",
  price_tag: "💶", shelf_context: "🗄",
};
type TemplateCard = { id: string; title: string; payer: string; blurb: string; icon: string; itemCount: number };
type DraftItem = { name: string; desc: string; nonce: string };
const PIPELINE = ["UPLOADING EVIDENCE", "HASHING → 0G STORAGE", "AI VISION ANALYZING", "SIGNING VERDICT", "SETTLING ON-CHAIN"];

/** Rotating pipeline status while an item is being verified. */
function PipelineTicker() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % PIPELINE.length), 1600);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="ticker">
      <span className="scanbar" />
      {PIPELINE[i]}
      <span className="cursor">▌</span>
    </span>
  );
}

function explorerBase(network: string): string | null {
  if (network === "hedera-testnet") return "https://hashscan.io/testnet";
  if (network === "hedera-mainnet") return "https://hashscan.io/mainnet";
  return null;
}

function Hash({ value, href, chars = 14 }: { value: string; href?: string | null; chars?: number }) {
  const short = value.length > chars ? value.slice(0, chars) + "…" : value;
  return href ? (
    <a className="hashlink" href={href} target="_blank" rel="noreferrer" title={value}>
      {short} ↗
    </a>
  ) : (
    <span className="hashval" title={value + " (local chain — explorer links appear on Hedera)"}>
      {short}
    </span>
  );
}

/** Barcode built from the real tx hash bytes — decoration that is also data. */
function HashBarcode({ hash }: { hash: string }) {
  const bytes = (hash || "0x00").replace(/^0x/, "").slice(0, 48);
  return (
    <div className="barcode" aria-hidden>
      {Array.from(bytes).map((c, i) => (
        <span key={i} style={{ width: 1 + (parseInt(c, 16) % 4), opacity: 0.55 + (parseInt(c, 16) % 8) / 16 }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// THE PAPER RECEIPT — prints out of the dark UI on release.
// ---------------------------------------------------------------------------
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
  const finalTx = Object.values(results).map((r) => r.txHash).filter(Boolean).pop() ?? "";
  const seal = Object.values(results).map((r) => r.hcsSeal).filter(Boolean).pop();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="paper-wrap" onClick={(e) => e.stopPropagation()}>
        <div className="printer-lip" />
        <div className="paper">
          <div className="perf perf-top" />

          <header className="paper-head">
            <div className="paper-brand">AIVY&nbsp;INSPECT</div>
            <div className="paper-sub">{checkout.template.toUpperCase()} · CRYPTOGRAPHIC RECEIPT · Nº {checkout.checkoutId}</div>
            <div className="paper-time">{when}</div>
            <div className="stamp">RELEASED · {checkout.depositHbar.toFixed(0)} ℏ</div>
          </header>

          <div className="paper-rule" />

          {checkout.items.map((item, idx) => {
            const r = results[item.name];
            if (!r) return null;
            const cidHref = r.evidenceUri.startsWith("http") ? r.evidenceUri : null;
            return (
              <section className="paper-item" key={item.name}>
                <div className="paper-item-head">
                  <span>{String(idx + 1).padStart(2, "0")} · {item.name.replace(/_/g, " ").toUpperCase()}</span>
                  <span className="ink-pass">PASS ✓</span>
                </div>
                <div className="paper-item-body">
                  {thumbs[item.name] && <img className="paper-thumb" src={thumbs[item.name]} alt={item.name} />}
                  <table className="paper-kv"><tbody>
                    <tr><td>evidence</td><td><Hash value={r.storageBackend === "0g" ? r.evidenceUri.replace("0g://", "") : r.imageHash} href={cidHref} chars={16} /></td></tr>
                    <tr><td>ai&nbsp;verdict</td><td>undamaged · nonce&nbsp;detected</td></tr>
                    <tr><td>signature</td><td><Hash value={r.signature} chars={16} /></td></tr>
                    {r.txHash && <tr><td>verdict&nbsp;tx</td><td><Hash value={r.txHash} href={exp ? `${exp}/transaction/${r.txHash}` : null} chars={16} /></td></tr>}
                  </tbody></table>
                </div>
              </section>
            );
          })}

          <div className="paper-rule" />

          <section className="paper-settle">
            <div className="paper-item-head"><span>SETTLEMENT</span><span>HEDERA {checkout.network === "hedera-testnet" ? "TESTNET" : ""}</span></div>
            <table className="paper-kv wide"><tbody>
              <tr><td>escrow</td><td><Hash value={checkout.escrow} href={exp ? `${exp}/contract/${checkout.escrow}` : null} chars={20} /></td></tr>
              {finalTx && <tr><td>release&nbsp;tx</td><td><Hash value={finalTx} href={exp ? `${exp}/transaction/${finalTx}` : null} chars={20} /></td></tr>}
              <tr><td>paid&nbsp;to</td><td><Hash value={checkout.tenant} href={exp ? `${exp}/account/${checkout.tenant}` : null} chars={20} /></td></tr>
              <tr><td>hcs&nbsp;topic</td><td>{checkout.hcsTopic
                ? <Hash value={checkout.hcsTopic + (seal ? ` · seq #${seal.sequence}` : "")} href={exp ? `${exp}/topic/${checkout.hcsTopic}` : null} chars={26} />
                : <span className="hashval">pending — set HCS_TOPIC_ID</span>}</td></tr>
            </tbody></table>
          </section>

          <HashBarcode hash={finalTx} />
          <p className="paper-foot">
            EVERY LINE INDEPENDENTLY VERIFIABLE · EVIDENCE HASH COMMITTED IN SIGNED VERDICT ·
            SIGNATURE CHECKED BY CONTRACT (ECRECOVER) BEFORE FUNDS MOVED · SEALED TO HEDERA CONSENSUS
          </p>

          <div className="perf perf-bottom" />
        </div>
        <button className="tear" onClick={onClose}>TEAR OFF ✂ CLOSE</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function App() {
  const [nullifier, setNullifier] = useNullifier();
  const [verified, setVerified] = useState(false);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, EvidenceResult>>({});
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [showReceipt, setShowReceipt] = useState(false);
  const [releasedAt, setReleasedAt] = useState<Date | null>(null);
  const [payout, setPayout] = useState<string>(() => localStorage.getItem("aivy:payout") ?? "");
  const [error, setError] = useState<string>("");
  const [health, setHealth] = useState<{ worldId: string; worldAppId?: string; worldAction?: string; network?: string } | null>(null);
  const [templates, setTemplates] = useState<TemplateCard[]>([]);
  const [picked, setPicked] = useState<TemplateCard | null>(null);
  const [building, setBuilding] = useState(false);
  const [draft, setDraft] = useState<DraftItem[]>([{ name: "", desc: "", nonce: "" }]);
  const starting = useRef(false);

  useEffect(() => {
    tg?.ready?.();
    tg?.expand?.();
    api<{ worldId: string; worldAppId?: string; worldAction?: string; network?: string }>("/api/health").then(setHealth).catch(() => {});
    api<{ templates: TemplateCard[] }>("/api/templates").then((t) => setTemplates(t.templates)).catch(() => {});
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

  const onWorldIdSuccess = useCallback(async (proof: ISuccessResult) => {
    setError("");
    try {
      const out = await api<{ ok: boolean; nullifier: string }>("/api/verify-human", { proof });
      setNullifier(out.nullifier);
      localStorage.setItem("aivy:nullifier", out.nullifier);
      setVerified(true);
      tg?.HapticFeedback?.notificationOccurred?.("success");
    } catch (e: any) {
      setError("World ID verification failed: " + e.message);
    }
  }, [setNullifier]);

  const start = useCallback(async () => {
    if (starting.current) return;
    starting.current = true;
    setError("");
    try {
      const addr = payout.trim();
      if (addr) localStorage.setItem("aivy:payout", addr);
      const payload: any = { nullifier, tenantAddress: addr || undefined };
      if (building) payload.customItems = draft;
      else if (picked) payload.templateId = picked.id;
      setCheckout(await api<Checkout>("/api/demo/checkout", payload));
    } catch (e: any) {
      setError(e.message);
    } finally {
      starting.current = false;
    }
  }, [nullifier, payout, picked, building, draft]);

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
  const total = checkout?.items.length ?? 0;

  return (
    <div className="stage">
      <div className="grain" aria-hidden />
      <div className="wrap">
        <header className="mast reveal">
          <div className="mast-row">
            <span className="mast-dot" />
            <span className="mast-proto">PROOF-OF-CHECKOUT PROTOCOL</span>
            <span className="mast-net">{health?.network === "hedera-testnet" ? "HEDERA·TESTNET" : health?.network === "hedera-mainnet" ? "HEDERA" : "LOCAL·CHAIN"}</span>
          </div>
          <h1 className="mast-brand">
            AIVY<span className="brand-slash">/</span>INSPECT
          </h1>
          <div className="mast-tag">verifiable inspection receipts for the physical world — AI judges the evidence, the chain moves the money</div>
        </header>

        {/* ─── GATE: personhood ─────────────────────────────────────── */}
        {!verified && (
          <section className="panel gate reveal d1">
            <div className="gate-ring">
              <div className="gate-ring-inner">☝</div>
            </div>
            <h2 className="panel-title">ONE HUMAN,<br />ONE CHECKOUT.</h2>
            <p className="panel-copy">
              Your World ID nullifier is the sybil-resistance key. No documents. No doxxing.
              Just proof there's a unique human behind this deposit.
            </p>
            {health?.worldAppId ? (
              <IDKitWidget
                app_id={health.worldAppId as `app_${string}`}
                action={health.worldAction ?? "aivy-checkout"}
                verification_level={VerificationLevel.Device}
                onSuccess={onWorldIdSuccess}
              >
                {({ open }) => (
                  <button className="cta" onClick={open}>VERIFY WITH WORLD ID</button>
                )}
              </IDKitWidget>
            ) : (
              <>
                <button className="cta" onClick={verify}>VERIFY PERSONHOOD</button>
                <p className="fine">SIMULATOR MODE — set WORLD_APP_ID server-side to go live</p>
              </>
            )}
          </section>
        )}

        {/* ─── HUB: pick a use case ─────────────────────────────────── */}
        {verified && !checkout && !picked && !building && (
          <section className="reveal d1">
            <div className="verified-chip">✓ HUMAN VERIFIED · {nullifier.slice(0, 14)}…</div>
            <h2 className="hub-title">PROOF FOR ANYTHING<br />YOU CAN PHOTOGRAPH.</h2>
            <p className="panel-copy hub-copy">
              One engine — escrow, liveness challenges, AI verdicts, sealed receipts. Pick an
              inspection, or design your own.
            </p>
            <div className="hub-grid">
              {templates.map((t, i) => (
                <button key={t.id} className={`usecase reveal d${(i % 3) + 1}`} onClick={() => setPicked(t)}>
                  {t.id === "rental_checkout" && <span className="flag">FLAGSHIP DEMO</span>}
                  <span className="usecase-icon">{t.icon}</span>
                  <span className="usecase-title">{t.title.toUpperCase()}</span>
                  <span className="usecase-blurb">{t.blurb}</span>
                  <span className="usecase-meta">{t.itemCount} CHECKS · PAYS: {t.payer.toUpperCase()}</span>
                </button>
              ))}
              <button className="usecase custom reveal d3" onClick={() => setBuilding(true)}>
                <span className="usecase-icon">＋</span>
                <span className="usecase-title">BUILD YOUR OWN</span>
                <span className="usecase-blurb">Define the checklist. The engine does the rest.</span>
                <span className="usecase-meta">ANY INDUSTRY · ANY HANDOVER</span>
              </button>
            </div>
          </section>
        )}

        {/* ─── BUILDER: custom inspection ───────────────────────────── */}
        {verified && !checkout && building && (
          <section className="panel reveal">
            <button className="backlink" onClick={() => setBuilding(false)}>← ALL USE CASES</button>
            <h2 className="panel-title">DESIGN YOUR<br />INSPECTION.</h2>
            <p className="panel-copy">Each check needs a name, what the AI should verify, and a physical liveness challenge.</p>
            {draft.map((d, i) => (
              <div className="draft" key={i}>
                <div className="draft-head">
                  <span className="fine">CHECK {String(i + 1).padStart(2, "0")}</span>
                  {draft.length > 1 && (
                    <button className="draft-x" onClick={() => setDraft(draft.filter((_, j) => j !== i))}>✕</button>
                  )}
                </div>
                <input className="addr" placeholder="item name — e.g. booth banner" value={d.name}
                  onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <input className="addr" placeholder="what the AI verifies — e.g. sponsor banner hung, undamaged" value={d.desc}
                  onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, desc: e.target.value } : x)))} />
                <input className="addr" placeholder="liveness challenge — e.g. hold two fingers next to the logo" value={d.nonce}
                  onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, nonce: e.target.value } : x)))} />
              </div>
            ))}
            {draft.length < 8 && (
              <button className="draft-add" onClick={() => setDraft([...draft, { name: "", desc: "", nonce: "" }])}>+ ADD CHECK</button>
            )}
            <div className="payout">
              <label className="fine" htmlFor="payout2">PAYOUT WALLET (OPTIONAL)</label>
              <input id="payout2" className="addr" placeholder="0x…" value={payout} onChange={(e) => setPayout(e.target.value)} spellCheck={false} />
            </div>
            <button className="cta" onClick={start}>ESCROW &amp; BEGIN</button>
          </section>
        )}

        {/* ─── BRIEFING: chosen template ────────────────────────────── */}
        {verified && !checkout && picked && !building && (
          <section className="panel reveal d1">
            <button className="backlink" onClick={() => setPicked(null)}>← ALL USE CASES</button>
            <div className="verified-chip">{picked.icon} {picked.title.toUpperCase()} · {picked.itemCount} CHECKS</div>
            <h2 className="panel-title">YOUR DEPOSIT IS<br />IN ESCROW.</h2>
            <p className="panel-copy">
              Locked in a Hedera smart contract. Pass every check and the
              contract pays out <em>the second</em> the last verdict lands. No counterparty mood. No 30-day wait.
            </p>
            <div className="payout">
              <label className="fine" htmlFor="payout">PAYOUT WALLET — YOUR OCULUSVAULT ADDRESS (OPTIONAL)</label>
              <input
                id="payout"
                className="addr"
                placeholder="0x…  leave empty for a demo wallet"
                value={payout}
                onChange={(e) => setPayout(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              <p className="fine">
                No wallet? <a className="hashlink" href="https://t.me/oculusvaultbot/app" target="_blank" rel="noreferrer">OPEN OCULUSVAULT ↗</a> — the deposit pays straight into it.
              </p>
            </div>
            <button className="cta" onClick={start}>BEGIN CHECKOUT</button>
          </section>
        )}

        {/* ─── CASE FILE: the checklist ─────────────────────────────── */}
        {checkout && (
          <>
            <section className={`casebar reveal ${released ? "done" : ""}`}>
              <div className="casebar-left">
                <span className="case-no">{checkout.templateIcon} {checkout.template.toUpperCase()} · CASE Nº {checkout.checkoutId}</span>
                <span className="case-amt">{checkout.depositHbar.toFixed(0)} ℏ IN ESCROW</span>
              </div>
              <div className="casebar-right">
                <div className="segs" aria-label={`${passedCount} of ${total} items sealed`}>
                  {checkout.items.map((it) => (
                    <span key={it.name} className={`seg ${it.passed ? "on" : ""}`} />
                  ))}
                </div>
                <span className={`case-status ${released ? "ok" : ""}`}>{released ? "RELEASED" : `${passedCount}/${total} SEALED`}</span>
              </div>
            </section>

            {released && (
              <section className="panel released reveal">
                <h2 className="panel-title glow">DEPOSIT<br />RELEASED.</h2>
                <p className="panel-copy">Funds hit the payout wallet the moment the last signed verdict cleared the contract.</p>
                <button className="cta" onClick={() => setShowReceipt(true)}>🧾 PRINT THE RECEIPT</button>
              </section>
            )}

            {checkout.items.map((item, idx) => {
              const r = results[item.name];
              const state = item.passed ? "pass" : r?.verdict === "FAIL" ? "fail" : "open";
              return (
                <section key={item.name} className={`evidence reveal d${idx + 1} ${state}`}>
                  <div className="ev-rail">
                    <span className="ev-no">{String(idx + 1).padStart(2, "0")}</span>
                    <span className="ev-line" />
                  </div>
                  <div className="ev-body">
                    <div className="ev-head">
                      <span className="ev-icon">{ITEM_ICON[item.name] ?? "▣"}</span>
                      <div className="ev-titles">
                        <b>{item.name.replace(/_/g, " ").toUpperCase()}</b>
                        <span className="ev-desc">{item.description}</span>
                      </div>
                      {state === "pass" && <span className="verdict-stamp pass">PASS</span>}
                      {state === "fail" && <span className="verdict-stamp fail">FAIL</span>}
                    </div>

                    {!item.passed && (
                      <>
                        <div className="challenge">
                          <span className="challenge-label">LIVENESS CHALLENGE</span>
                          <span className="challenge-text">{item.nonceInstruction}</span>
                        </div>
                        <label className={`capture ${busyItem === item.name ? "busy" : ""}`}>
                          {busyItem === item.name ? <PipelineTicker /> : <span>◉&nbsp;&nbsp;CAPTURE EVIDENCE</span>}
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
                      <div className="ev-result">
                        <div className="ev-kv"><span>ai&nbsp;verdict</span><span className={r.verdict === "PASS" ? "ink-lime" : "ink-red"}>{r.verdict} · {r.brain}</span></div>
                        <div className="ev-kv"><span>reason</span><span>{r.reason}</span></div>
                        <div className="ev-kv"><span>evidence</span><span>{r.imageHash.slice(0, 18)}… ({r.storageBackend})</span></div>
                        {r.txHash && <div className="ev-kv"><span>tx</span><span>{r.txHash.slice(0, 18)}…</span></div>}
                      </div>
                    )}
                  </div>
                </section>
              );
            })}
          </>
        )}

        {showReceipt && released && checkout && (
          <Receipt
            checkout={checkout}
            results={results}
            thumbs={thumbs}
            releasedAt={releasedAt ?? new Date()}
            onClose={() => setShowReceipt(false)}
          />
        )}

        {error && <div className="errorbar reveal">⚠ {error}</div>}

        <footer className="colophon">
          ECRECOVER-VERIFIED VERDICTS · EVIDENCE HASHED ON-CHAIN · RECEIPTS SEALED TO HCS
          <br />HEDERA × 0G × WORLD ID — ETHGLOBAL LISBOA
        </footer>
      </div>
    </div>
  );
}

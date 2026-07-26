import { useCallback, useEffect, useRef, useState } from "react";
// World ID 4.0 (branch: world-selfie-v4) — request-widget + backend-signed
// rp_context. Selfie Check preset is the whole point of this branch.
import { IDKitRequestWidget, deviceLegacy, proofOfHuman, selfieCheckLegacy, type RpContext } from "@worldcoin/idkit";

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
  geoLock: boolean;
  timeLockMinutes: number;
  deadline?: number;
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
  storageRoot?: string | null;
  geo?: { lat: number; lng: number; acc?: number | null } | null;
  teeVerified?: boolean | null;
  computeModel?: string | null;
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

/**
 * iPhones hand us HEIC, which the vision API rejects outright (400 unsupported
 * image) — the verdict never runs and the item just fails. Re-encode every
 * capture to JPEG through a canvas, downscaling on the way: it also turns a
 * 4 MB photo into ~300 KB, which on venue wifi is the difference between a
 * 2-second and a 20-second upload.
 */
async function fileToJpegDataUrl(f: File, maxEdge = 1600, quality = 0.85): Promise<string> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(f, { imageOrientation: "from-image" } as any);
  } catch {
    try {
      bitmap = await createImageBitmap(f); // older Safari: no orientation option
    } catch {
      return fileToDataUrl(f); // can't decode it here — let the server say why
    }
  }
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return fileToDataUrl(f);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", quality);
}

const ITEM_ICON: Record<string, string> = {
  chair: "🪑", laptop: "💻", table: "🍽", espresso_machine: "☕", bedroom_door: "🚪",
  receipt_total: "🧾", receipt_header: "🏷",
  front_bumper: "🚗", driver_side: "🪞", dashboard: "🎛",
  scooter_deck: "🛴", brake_lever: "🖐", battery_readout: "🔋",
  parcel_intact: "📦", label_visible: "🏷", product_facing: "🛒",
  price_tag: "💶", shelf_context: "🗄",
};
type ArchivedItem = { item: string; verdict: "PASS" | "FAIL"; tx?: string };
type Archived = {
  sequence: number;
  checkoutId: number;
  outcome: string;
  tenant?: string;
  releaseTx?: string;
  ts: string;
  items: ArchivedItem[];
};
type TemplateCard = { id: string; title: string; payer: string; blurb: string; icon: string; itemCount: number; depositHbar: number; geoLock: boolean; timeLockMinutes: number; brain: string };
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

/**
 * Opening a checkout costs two Hedera transactions at ~5s of consensus each —
 * dead air unless you narrate it. Every row here is a real call the relayer is
 * making right now, timed to what the mirror node actually reports. The last
 * row deliberately outlives this component: commitNonce runs in the background
 * (see createDemoCheckout) and is awaited later, at the first evidence upload.
 */
const SETTLE_STEPS = [
  {
    label: "OPENING THE CASE FILE",
    call: "createCheckout()",
    note: "required items + a 30-minute deadline, written on-chain",
  },
  {
    label: "LOCKING THE DEPOSIT",
    call: "deposit()",
    note: "2 ℏ held by the contract — not by the host, not by us",
  },
  {
    label: "SEALING THE LIVENESS CHALLENGES",
    call: "commitNonce()",
    note: "hashed now, revealed only at capture — that's the anti-replay",
  },
];
const SETTLE_STEP_MS = 5400; // measured: ~5s per tx on Hedera testnet

function SettlementTicker({ items }: { items: number }) {
  const [step, setStep] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const t0 = Date.now();
    const tick = setInterval(() => setElapsed((Date.now() - t0) / 1000), 100);
    const timers = [1, 2].map((n) => setTimeout(() => setStep(n), SETTLE_STEP_MS * n));
    return () => {
      clearInterval(tick);
      timers.forEach(clearTimeout);
    };
  }, []);

  return (
    <div className="settle">
      <div className="settle-head">
        <span className="settle-title">SETTLING ON HEDERA</span>
        <span className="settle-clock">{elapsed.toFixed(1)}s</span>
      </div>
      <ol className="settle-steps">
        {SETTLE_STEPS.map((s, i) => (
          <li key={s.call} className={i < step ? "done" : i === step ? "active" : "pending"}>
            <span className="settle-mark">{i < step ? "✓" : i === step ? <span className="settle-spin" /> : "○"}</span>
            <div>
              <div className="settle-label">
                {s.label}
                <code>{i === 2 ? `${s.call} ×${items}` : s.call}</code>
              </div>
              <div className="settle-note">{s.note}</div>
            </div>
          </li>
        ))}
      </ol>
      <div className="settle-bar">
        {/* creep toward — never quite reach — the two-tx estimate; the real
            response is what ends this, and Hedera occasionally runs long */}
        <span style={{ width: `${Math.min(96, (elapsed / ((SETTLE_STEP_MS * 2) / 1000)) * 100)}%` }} />
      </div>
      <p className="settle-foot">THE RELAYER PAYS THE GAS · THE TENANT NEVER SIGNS A TRANSACTION</p>
    </div>
  );
}

/**
 * The raw backend enum leaks into the UI otherwise, and "0g-pending" reads like
 * a bug rather than what it is: the blob is on its way to 0G and we refused to
 * make a human wait for finalization. Same hash goes on-chain either way.
 */
const STORAGE_LABEL: Record<string, string> = {
  "0g": "0G STORAGE",
  "0g-pending": "0G · FINALIZING",
  local: "LOCAL FALLBACK",
};

function Countdown({ to }: { to: number }) {
  const [left, setLeft] = useState(() => Math.max(0, to - Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, to - Math.floor(Date.now() / 1000))), 1000);
    return () => clearInterval(t);
  }, [to]);
  const m = Math.floor(left / 60), sec = left % 60;
  return <b className={`lockchip ${left < 120 ? "hot" : ""}`}>⏱ {m}:{String(sec).padStart(2, "0")}</b>;
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
  tier,
  nullifier,
  onClose,
}: {
  checkout: Checkout;
  results: Record<string, EvidenceResult>;
  thumbs: Record<string, string>;
  releasedAt: Date;
  tier: "device" | "selfie" | "orb";
  nullifier: string;
  onClose: () => void;
}) {
  const exp = explorerBase(checkout.network);
  const when = new Intl.DateTimeFormat("en-US", {
    month: "long", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(releasedAt);
  const finalTx = Object.values(results).map((r) => r.txHash).filter(Boolean).pop() ?? "";
  const seal = Object.values(results).map((r) => r.hcsSeal).filter(Boolean).pop();

  const shareReceipt = useCallback(async () => {
    const proofUrl = exp && finalTx ? `${exp}/transaction/${finalTx}` : "https://checkout.aivylabs.xyz";
    const text = `🧾 ${checkout.template} passed — ${checkout.depositHbar.toFixed(0)} ℏ deposit released on-chain the second the last AI verdict landed. Every item verified, receipt sealed to Hedera Consensus. Proof:`;
    const tgApp = (window as any).Telegram?.WebApp;
    if (tgApp?.openTelegramLink) {
      // native Telegram share sheet — pick any contact/chat
      tgApp.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(proofUrl)}&text=${encodeURIComponent(text)}`);
      return;
    }
    if (navigator.share) {
      try { await navigator.share({ title: "Aivy Checkout receipt", text, url: proofUrl }); return; } catch { /* user cancelled */ }
    }
    try {
      await navigator.clipboard.writeText(`${text} ${proofUrl}`);
      alert("Receipt proof copied to clipboard");
    } catch { /* nothing sane left */ }
  }, [checkout, finalTx, exp]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="paper-wrap" onClick={(e) => e.stopPropagation()}>
        <div className="printer-lip" />
        <div className="paper">
          <div className="perf perf-top" />

          <header className="paper-head">
            <div className="paper-brand">AIVY&nbsp;CHECKOUT</div>
            <div className="paper-sub">{checkout.template.toUpperCase()} · CRYPTOGRAPHIC RECEIPT · Nº {checkout.checkoutId}</div>
            <div className="paper-time">{when}</div>
            <div className="stamp">RELEASED · {checkout.depositHbar.toFixed(0)} ℏ</div>
            {(checkout.geoLock || checkout.timeLockMinutes !== 30) && (
              <div className="paper-locks">
                {checkout.geoLock && "📍 GEO-LOCKED"}{checkout.geoLock && checkout.timeLockMinutes !== 30 && " · "}
                {checkout.timeLockMinutes !== 30 && `⏱ ${checkout.timeLockMinutes}-MIN WINDOW`}
              </div>
            )}
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
                    <tr><td>{r.storageBackend === "0g" ? <>0g&nbsp;root</> : "evidence"}</td><td><Hash value={r.storageRoot ?? r.imageHash} href={cidHref} chars={16} /></td></tr>
                    <tr><td>ai&nbsp;verdict</td><td>undamaged · nonce&nbsp;detected</td></tr>
                    <tr><td>verifier</td><td>{r.brain === "0g-compute"
                      ? <>0G&nbsp;COMPUTE · {(r.computeModel ?? "").replace("qwen/", "")}{r.teeVerified ? <b className="ink-pass"> · TEE&nbsp;SIG&nbsp;✓</b> : " · sig unverified"}</>
                      : r.brain === "openai" ? (checkout as any).verifierBrain === "0g-compute" ? "GPT VISION (fallback)" : "GPT VISION" : r.brain}</td></tr>
                    <tr><td>signature</td><td><Hash value={r.signature} chars={16} /></td></tr>
                    {r.txHash && <tr><td>verdict&nbsp;tx</td><td><Hash value={r.txHash} href={exp ? `${exp}/transaction/${r.txHash}` : null} chars={16} /></td></tr>}
                    {r.geo && <tr><td>geo</td><td>{r.geo.lat.toFixed(5)}, {r.geo.lng.toFixed(5)} (±{r.geo.acc ?? "?"}m)</td></tr>}
                  </tbody></table>
                </div>
              </section>
            );
          })}

          <div className="paper-rule" />

          <section className="paper-settle">
            <div className="paper-item-head"><span>SETTLEMENT</span><span>HEDERA {checkout.network === "hedera-testnet" ? "TESTNET" : ""}</span></div>
            <table className="paper-kv wide"><tbody>
              <tr><td>human</td><td>WORLD&nbsp;ID&nbsp;✓ · {tier === "orb" ? "ORB (proof of human)" : tier === "selfie" ? "SELFIE CHECK" : "DEVICE"} tier · <span title={nullifier}>{nullifier.slice(0, 14)}…</span></td></tr>
              <tr><td>escrow</td><td><Hash value={checkout.escrow} href={exp ? `${exp}/contract/${checkout.escrow}` : null} chars={20} /></td></tr>
              {finalTx && <tr><td>release&nbsp;tx</td><td><Hash value={finalTx} href={exp ? `${exp}/transaction/${finalTx}` : null} chars={20} /></td></tr>}
              <tr><td>paid&nbsp;to</td><td><Hash value={checkout.tenant} href={exp ? `${exp}/account/${checkout.tenant}` : null} chars={20} /></td></tr>
              <tr><td>hcs&nbsp;topic</td><td>{checkout.hcsTopic
                ? <Hash value={checkout.hcsTopic + (seal ? ` · seq #${seal.sequence}` : "")} href={exp ? `${exp}/topic/${checkout.hcsTopic}` : null} chars={26} />
                : <span className="hashval">pending — set HCS_TOPIC_ID</span>}</td></tr>
            </tbody></table>
          </section>

          <div className="stack-strip" aria-label="protocol stack">
            <span>⛓ HEDERA<br/><i>escrow · HCS trail</i></span>
            <span>🌐 WORLD<br/><i>verified human · {tier}</i></span>
            <span>🧠 0G<br/><i>{Object.values(results).some(r => r.brain === "0g-compute") ? "storage · verified inference" : "evidence storage"}</i></span>
          </div>

          <HashBarcode hash={finalTx} />
          <p className="paper-foot">
            EVERY LINE INDEPENDENTLY VERIFIABLE · EVIDENCE HASH COMMITTED IN SIGNED VERDICT ·
            SIGNATURE CHECKED BY CONTRACT (ECRECOVER) BEFORE FUNDS MOVED · SEALED TO HEDERA CONSENSUS
          </p>

          <div className="perf perf-bottom" />
        </div>
        <div className="tear-row">
          <button className="tear share" onClick={shareReceipt}>📤 SHARE PROOF</button>
          <button className="tear" onClick={onClose}>TEAR OFF ✂ CLOSE</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function App() {
  const [nullifier, setNullifier] = useNullifier();
  /**
   * A reload used to throw you back to the QR even though the nullifier was
   * cached — brutal when the demo runs several times. Remember the gate, but
   * only optimistically: in live mode the server accepts a bare nullifier only
   * if it proved itself since the last boot, so any personhood rejection drops
   * this and puts the gate back (see dropVerification).
   */
  const [verified, setVerified] = useState(() => localStorage.getItem("aivy:verified") === "1");
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, EvidenceResult>>({});
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [showReceipt, setShowReceipt] = useState(false);
  const [releasedAt, setReleasedAt] = useState<Date | null>(null);
  const [payout, setPayout] = useState<string>(() => localStorage.getItem("aivy:payout") ?? "");
  const [error, setError] = useState<string>("");
  const [health, setHealth] = useState<{ worldId: string; worldAppId?: string; worldAction?: string; network?: string; hcsTopic?: string | null; worldRpId?: string | null; computeEnabled?: boolean } | null>(null);
  const [templates, setTemplates] = useState<TemplateCard[]>([]);
  const [archive, setArchive] = useState<Archived[]>([]);
  const [picked, setPicked] = useState<TemplateCard | null>(null);
  const [building, setBuilding] = useState(false);
  const [draft, setDraft] = useState<DraftItem[]>([{ name: "", desc: "", nonce: "" }]);
  const [geoLock, setGeoLock] = useState(false);
  const [brain, setBrain] = useState<"0g-compute" | "openai">("0g-compute");
  const [tier, setTier] = useState<"device" | "selfie" | "orb">("device");
  const [capHbar, setCapHbar] = useState(2);
  const [selfieEnabled, setSelfieEnabled] = useState(false);
  const [stepUp, setStepUp] = useState<"selfie" | "orb" | null>(null);
  const [timeLock, setTimeLock] = useState(0); // 0 = default 30min, else minutes
  const starting = useRef(false);
  const wantFresh = useRef(false);
  const [settling, setSettling] = useState(false);

  useEffect(() => {
    tg?.ready?.();
    tg?.expand?.();
    // the Evidence Lab is dark by design — without this, Telegram frames it in
    // the viewer's own theme and a light-mode judge gets a white header band
    tg?.setHeaderColor?.("#07090d");
    tg?.setBackgroundColor?.("#07090d");
    api<{ worldId: string; worldAppId?: string; worldAction?: string; network?: string; hcsTopic?: string | null; worldRpId?: string | null; computeEnabled?: boolean }>("/api/health").then(setHealth).catch(() => {});
    api<{ templates: TemplateCard[] }>("/api/templates").then((t) => setTemplates(t.templates)).catch(() => {});
    loadArchive();
  }, []);

  /** The archive is a mirror-node read of the HCS topic — see readHistory(). */
  const loadArchive = useCallback(() => {
    api<{ receipts: Archived[] }>("/api/history").then((h) => setArchive(h.receipts ?? [])).catch(() => {});
  }, []);

  // ── World ID 4.0 plumbing ─────────────────────────────────────────
  const [worldOpen, setWorldOpen] = useState(false);
  const [worldKind, setWorldKind] = useState<"gate" | "orb" | "selfie">("gate");
  const [rpContext, setRpContext] = useState<RpContext | null>(null);
  const worldResult = useRef<any>(null);

  const startWorld = useCallback(async (kind: "gate" | "orb" | "selfie") => {
    setError("");
    if (!health?.worldRpId) {
      setError("World ID 4.0 not configured yet — set WORLD_RP_ID / WORLD_RP_SIGNING_KEY (opens with Selfie beta access)");
      return;
    }
    try {
      const sig = await api<any>("/api/world/rp-signature", { action: health.worldAction ?? "aivy-checkout" });
      setRpContext({
        rp_id: sig.rp_id,
        nonce: sig.nonce,
        created_at: sig.created_at,
        expires_at: sig.expires_at,
        signature: sig.sig,
      } as RpContext);
      setWorldKind(kind);
      setWorldOpen(true);
    } catch (e: any) {
      setError(e.message);
    }
  }, [health]);

  const worldPreset =
    worldKind === "selfie" ? selfieCheckLegacy({ signal: "aivy-checkout" }) :
    worldKind === "orb" ? proofOfHuman({ signal: "aivy-checkout" }) :
    deviceLegacy({ signal: "aivy-checkout" });

  const applyWorldSession = useCallback((out: any) => {
    if (out?.linkedWallet && !payout) setPayout(out.linkedWallet);
    if (out?.tier) { setTier(out.tier); setCapHbar(out.capHbar ?? 2); setSelfieEnabled(!!out.selfieEnabled); }
    if (out?.nullifier) {
      setNullifier(out.nullifier);
      localStorage.setItem("aivy:nullifier", out.nullifier);
    }
    localStorage.setItem("aivy:verified", "1");
    setVerified(true);
    setStepUp(null);
    tg?.HapticFeedback?.notificationOccurred?.("success");
  }, [payout, setNullifier]);

  const verify = useCallback(async () => {
    setError("");
    try {
      const out = await api<{ linkedWallet?: string | null; tier?: any; capHbar?: number; selfieEnabled?: boolean }>("/api/verify-human", { nullifier });
      if (out.linkedWallet && !payout) setPayout(out.linkedWallet);
      if (out.tier) { setTier(out.tier); setCapHbar(out.capHbar ?? 2); setSelfieEnabled(!!out.selfieEnabled); }
      setVerified(true);
      localStorage.setItem("aivy:verified", "1");
      tg?.HapticFeedback?.notificationOccurred?.("success");
    } catch (e: any) {
      setError(e.message);
    }
  }, [nullifier]);

  // v4: handleVerify runs while the widget is open; the server forwards the
  // idkit response to /api/v4/verify/{rp_id} and returns our session (tier,
  // nullifier, cap). onSuccess then applies it via applyWorldSession.
  const handleWorldVerify = useCallback(async (result: unknown) => {
    const out = await api<any>("/api/world/verify-v4", {
      idkitResponse: result,
      // lets the server cap a demo-clamped session's selfie step at SELFIE
      // tier even when World presents the stronger orb credential
      stepKind: worldKind,
    });
    worldResult.current = out;
  }, [worldKind]);

  /**
   * Practice runs need a way out that isn't "close the Mini App". Clearing the
   * case drops you back at the use-case picker; wantFresh then stops the server
   * resuming the case you just walked away from (see createDemoCheckout) —
   * otherwise the next run inherits its already-passed items and can't redo them.
   */
  /**
   * The remembered gate is optimistic: the server only accepts a bare nullifier
   * that proved itself since its last boot. If it says no, put the QR back
   * rather than leaving someone staring at a rejection they can't act on.
   */
  /** Demo control: forget this human entirely — clears the World session,
   *  nullifier, linked wallet and case, and reloads to the gate. Lets the
   *  full World ID connect flow be shown again on demand. */
  const signOut = useCallback(() => {
    ["aivy:verified", "aivy:nullifier", "aivy:payout"].forEach((k) => localStorage.removeItem(k));
    location.reload();
  }, []);

  const dropVerification = useCallback(() => {
    localStorage.removeItem("aivy:verified");
    setVerified(false);
    setError("that session expired — verify once more with World ID");
  }, []);

  const resetDemo = useCallback(() => {
    wantFresh.current = true;
    setCheckout(null);
    setResults({});
    setThumbs({});
    setShowReceipt(false);
    setReleasedAt(null);
    setPicked(null);
    setBuilding(false);
    setError("");
    tg?.HapticFeedback?.impactOccurred?.("light");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const start = useCallback(async () => {
    if (starting.current) return;
    starting.current = true;
    setSettling(true);
    setError("");
    try {
      const addr = payout.trim();
      if (addr) localStorage.setItem("aivy:payout", addr);
      const payload: any = { nullifier, tenantAddress: addr || undefined };
      if (building) {
        // the builder IS the designer — their choices define the inspection
        payload.geoLock = geoLock;
        payload.timeLockMinutes = timeLock || 30;
        payload.brain = health?.computeEnabled ? brain : "openai";
      }
      if (wantFresh.current) {
        payload.fresh = true;
        wantFresh.current = false;
      }
      if (building) payload.customItems = draft;
      else if (picked) payload.templateId = picked.id;
      setCheckout(await api<Checkout>("/api/demo/checkout", payload));
    } catch (e: any) {
      const gate = /^TIER_GATE:(selfie|orb):(.*)$/.exec(e.message ?? "");
      if (gate) {
        setStepUp(gate[1] as "selfie" | "orb");
        setError(gate[2]);
        setPicked(null); // back to the hub, where the step-up panel renders
        setBuilding(false);
      } else if (/personhood/i.test(e.message)) dropVerification();
      else setError(e.message);
    } finally {
      starting.current = false;
      setSettling(false);
    }
  }, [nullifier, payout, picked, building, draft, geoLock, timeLock, brain, health]);

  const submit = useCallback(
    async (item: Item, file: File) => {
      if (!checkout) return;
      setBusyItem(item.name);
      setError("");
      try {
        const imageDataUrl = await fileToJpegDataUrl(file);
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
          // the seal lands a beat after the release; give HCS + the mirror node
          // a moment before asking for the archive again
          setTimeout(loadArchive, 6000);
        }
        tg?.HapticFeedback?.notificationOccurred?.(out.verdict === "PASS" ? "success" : "error");
      } catch (e: any) {
        if (/personhood/i.test(e.message)) dropVerification();
        else setError(e.message);
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
            AIVY<span className="brand-slash">/</span>CHECKOUT
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
              <button className="cta" onClick={() => startWorld("gate")}>VERIFY WITH WORLD ID</button>
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
            <div className="chips">
              <span className="verified-chip">✓ HUMAN VERIFIED · {nullifier.slice(0, 14)}…</span>
              <span className={`tier-chip t-${tier}`}>{tier === "orb" ? "⚪ ORB" : tier === "selfie" ? "🤳 SELFIE" : "🟢 DEVICE"} · CAP {capHbar} ℏ</span>
              {tier !== "device" && (
                <button
                  className="tier-chip demo-clamp"
                  title="Demo control: see the app the way a device-only World user does — locked cards, unlock ladder."
                  onClick={async () => {
                    const out = await api<any>("/api/demo-tier", { nullifier, tier: "device" });
                    if (out?.tier) { setTier(out.tier); setCapHbar(out.capHbar ?? 2); }
                  }}
                >
                  👁 VIEW AS DEVICE TIER
                </button>
              )}
            </div>
            {templates.some((t) => t.depositHbar > capHbar) && (
              <div className="unlock-strip reveal">
                <span className="unlock-copy">
                  🔒 Escrows above {capHbar} ℏ need a higher World ID assurance tier.
                </span>
                {selfieEnabled && tier === "device" ? (
                  <button className="cta" onClick={() => startWorld("selfie")}>🤳 UNLOCK WITH SELFIE CHECK</button>
                ) : (
                  <button className="cta" onClick={() => startWorld("orb")}>⚪ UNLOCK WITH ORB</button>
                )}
              </div>
            )}
            <h2 className="hub-title">PROOF FOR ANYTHING<br />YOU CAN PHOTOGRAPH.</h2>
            <p className="panel-copy hub-copy">
              One engine — escrow, liveness challenges, AI verdicts, sealed receipts. Pick an
              inspection, or design your own.
            </p>
            <div className="hub-grid">
              {templates.map((t, i) => {
                const locked = t.depositHbar > capHbar;
                const need = t.depositHbar <= 10 ? "selfie" : "orb";
                return (
                  <button
                    key={t.id}
                    className={`usecase reveal d${(i % 3) + 1}${locked ? " locked" : ""}`}
                    // a locked card IS the unlock button — no dead-end taps
                    onClick={() => (locked ? startWorld(need === "selfie" && selfieEnabled ? "selfie" : "orb") : setPicked(t))}
                  >
                    {t.id === "rental_checkout" && <span className="flag">FLAGSHIP DEMO</span>}
                    {locked && <span className="lockmark">🔒 {need === "selfie" ? "SELFIE" : "ORB"} TIER</span>}
                    <span className="usecase-icon">{t.icon}</span>
                    <span className="usecase-title">{t.title.toUpperCase()}</span>
                    <span className="usecase-blurb">{t.blurb}</span>
                    <span className="usecase-meta">
                      {t.itemCount} CHECKS · {t.depositHbar} ℏ ESCROW · PAYS: {t.payer.toUpperCase()}
                    </span>
                    {locked && <span className="usecase-unlock">TAP TO UNLOCK {need === "selfie" ? "WITH SELFIE CHECK 🤳" : "WITH ORB ⚪"}</span>}
                  </button>
                );
              })}
              {stepUp && (
                <div className="stepup reveal">
                  <b className="stepup-title">🔒 HIGHER ASSURANCE REQUIRED</b>
                  <p className="stepup-copy">
                    This escrow size needs the {stepUp === "selfie" ? "SELFIE" : "ORB"} tier. Your World ID
                    assurance level literally sets your economic limits here.
                  </p>
                  <div className="stepup-actions">
                    {selfieEnabled ? (
                      <button className="cta" onClick={() => startWorld("selfie")}>🤳 SELFIE CHECK</button>
                    ) : (
                      <button className="cta ghost" disabled>🤳 SELFIE CHECK — BETA OPENS THIS WEEKEND</button>
                    )}
                    {health?.worldAppId && (
                      <button className="cta" onClick={() => startWorld("orb")}>⚪ VERIFY WITH ORB</button>
                    )}
                  </div>
                </div>
              )}
              <button className="usecase custom reveal d3" onClick={() => setBuilding(true)}>
                <span className="usecase-icon">＋</span>
                <span className="usecase-title">BUILD YOUR OWN</span>
                <span className="usecase-blurb">Define the checklist. The engine does the rest.</span>
                <span className="usecase-meta">ANY INDUSTRY · ANY HANDOVER</span>
              </button>
            </div>
          </section>
        )}

        {/* ─── ARCHIVE: past cases, replayed from HCS ───────────────── */}
        {verified && !checkout && !picked && !building && archive.length > 0 && (
          <>
            {/* a judge should never mistake the archive for the live flow —
                break the page here, drop the lime accent, go read-only */}
            <div className="section-break"><span>ARCHIVE</span></div>
            <section className="archive-zone reveal d3">
              <div className="archive-head">
                <h2 className="archive-title">EVERY CASE STAYS PROVABLE.</h2>
                <span className="archive-tag">READ-ONLY</span>
              </div>
              <p className="archive-copy">
                Not rows in our database — the receipts themselves, read back from Hedera
                Consensus Service. Anyone with the topic can replay them.
              </p>
            <ul className="arch-list">
              {archive.map((h) => (
                <li key={h.sequence} className="arch-row">
                  <div className="arch-head">
                    <span className="arch-no">CASE Nº {h.checkoutId}</span>
                    <span className="arch-when">{new Date(h.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                  <div className="arch-items">
                    {h.items.map((it, i) => (
                      <span key={i} className={`arch-chip ${it.verdict === "PASS" ? "ok" : "no"}`}>
                        {ITEM_ICON[it.item] ?? "▣"} {it.item.replace(/_/g, " ")} {it.verdict === "PASS" ? "✓" : "✕"}
                      </span>
                    ))}
                  </div>
                  <div className="arch-foot">
                    <span className="arch-seal">HCS SEQ #{h.sequence} · {h.outcome}</span>
                    {h.releaseTx && explorerBase(health?.network ?? "") && (
                      <a className="hashlink" href={`${explorerBase(health?.network ?? "")}/transaction/${h.releaseTx}`} target="_blank" rel="noreferrer">
                        release tx ↗
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
              {health?.hcsTopic && explorerBase(health?.network ?? "") && (
                <a className="hashlink arch-topic" href={`${explorerBase(health?.network ?? "")}/topic/${health.hcsTopic}`} target="_blank" rel="noreferrer">
                  OPEN TOPIC {health.hcsTopic} ON HASHSCAN ↗
                </a>
              )}
            </section>
          </>
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
                <input className="addr" placeholder="item name — e.g. handwritten note" value={d.name}
                  onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <input className="addr" placeholder='what the AI verifies — e.g. paper note reading "AIVY WAS HERE"' value={d.desc}
                  onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, desc: e.target.value } : x)))} />
                <input className="addr" placeholder="liveness challenge — e.g. hold the note next to the green lamp" value={d.nonce}
                  onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, nonce: e.target.value } : x)))} />
              </div>
            ))}
            {draft.length < 8 && (
              <button className="draft-add" onClick={() => setDraft([...draft, { name: "", desc: "", nonce: "" }])}>+ ADD CHECK</button>
            )}
            {payout ? (
              <div className="linked">
                <span className="fine">PAYS TO</span>
                <span className="linked-addr">{payout.slice(0, 10)}…{payout.slice(-6)} <b className="ink-lime">✓ LINKED</b></span>
                <button className="linked-change" onClick={() => setPayout("")}>CHANGE</button>
              </div>
            ) : (
              <div className="payout">
                <label className="fine" htmlFor="payout2">PAYOUT WALLET (OPTIONAL)</label>
                <input id="payout2" className="addr" placeholder="0x…" value={payout} onChange={(e) => setPayout(e.target.value)} spellCheck={false} />
              </div>
            )}
            {/* the builder opens the same escrow as a template, so it owes the
                same ~10s of narration — this path was left inert */}
            <div className="locks">
              <label className="lock">
                <input type="checkbox" checked={geoLock} onChange={(e) => setGeoLock(e.target.checked)} />
                <span className="lock-box" />
                <span className="lock-text"><b>📍 GEO-LOCK</b><i>GPS sealed into every capture — proves WHERE</i></span>
              </label>
              <label className="lock">
                <input type="checkbox" checked={timeLock > 0} onChange={(e) => setTimeLock(e.target.checked ? 15 : 0)} />
                <span className="lock-box" />
                <span className="lock-text"><b>⏱ TIME LOCK</b><i>evidence window enforced on-chain — proves WHEN</i></span>
              </label>
              {timeLock > 0 && (
                <div className="lock-mins">
                  {[15, 30, 60].map((m) => (
                    <button key={m} className={timeLock === m ? "on" : ""} onClick={() => setTimeLock(m)}>{m} MIN</button>
                  ))}
                </div>
              )}
              {health?.computeEnabled && (
                <div className="brainsel">
                  <span className="lock-text"><b>🧠 VERIFIER</b><i>who judges your evidence</i></span>
                  <div className="lock-mins brain-mins">
                    <button className={brain === "0g-compute" ? "on" : ""} onClick={() => setBrain("0g-compute")}>0G TEE · VERIFIABLE</button>
                    <button className={brain === "openai" ? "on" : ""} onClick={() => setBrain("openai")}>GPT · FRONTIER</button>
                  </div>
                </div>
              )}
            </div>
            {settling ? (
              <SettlementTicker items={draft.length} />
            ) : (
                          <button className="cta" onClick={start}>ESCROW &amp; BEGIN</button>
            )}
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
            {payout ? (
              <div className="linked">
                <span className="fine">PAYS TO</span>
                <span className="linked-addr">{payout.slice(0, 10)}…{payout.slice(-6)} <b className="ink-lime">✓ LINKED</b></span>
                <button className="linked-change" onClick={() => setPayout("")}>CHANGE</button>
              </div>
            ) : (
              <div className="payout">
                <label className="fine" htmlFor="payout">PAYOUT WALLET — LINK ONCE, NEVER ASKED AGAIN (OPTIONAL)</label>
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
            )}
            {/* Terms are DESIGNED into the inspection by the host/template —
                the tenant reads them, they don't negotiate them. */}
            <div className="terms">
              <span className="fine">INSPECTION TERMS — SET BY THE HOST</span>
              <div className="terms-row">
                <span className={`term ${picked.geoLock ? "on" : ""}`}>📍 {picked.geoLock ? "GEO-LOCKED — GPS sealed per capture" : "no geo requirement"}</span>
                <span className="term on">⏱ {picked.timeLockMinutes}-MIN WINDOW — enforced on-chain</span>
                <span className="term on">🧠 {picked.brain === "0g-compute" ? "0G TEE VERIFIER — verifiable inference" : "GPT VERIFIER"}</span>
              </div>
            </div>
            {settling ? (
              <SettlementTicker items={building ? draft.length : picked?.itemCount ?? 3} />
            ) : (
                          <button className="cta" onClick={start}>BEGIN CHECKOUT</button>
            )}
          </section>
        )}

        {/* ─── CASE FILE: the checklist ─────────────────────────────── */}
        {checkout && (
          <>
            <section className={`casebar reveal ${released ? "done" : ""}`}>
              <div className="casebar-left">
                <span className="case-no">{checkout.templateIcon} {checkout.template.toUpperCase()} · CASE Nº {checkout.checkoutId}</span>
                <span className="case-amt">
                  {checkout.depositHbar.toFixed(0)} ℏ IN ESCROW
                  {checkout.geoLock && <b className="lockchip">📍 GEO</b>}
                  {checkout.deadline && !released && <Countdown to={checkout.deadline} />}
                </span>
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

            <button className="case-exit" onClick={resetDemo}>
              {released ? "▸  RUN ANOTHER CHECKOUT" : "←  BACK TO USE CASES"}
            </button>

            {released && (
              <section className="panel released reveal">
                <h2 className="panel-title glow">DEPOSIT<br />RELEASED.</h2>
                <p className="panel-copy">Funds hit the payout wallet the moment the last signed verdict cleared the contract.</p>
                <button className="cta" onClick={() => setShowReceipt(true)}>🧾 PRINT THE RECEIPT</button>
                <button className="case-exit" onClick={resetDemo}>▸&nbsp;&nbsp;RUN ANOTHER CHECKOUT</button>
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
                            // naming the formats (rather than image/*) makes iOS
                            // transcode HEIC to JPEG before it reaches us
                            accept="image/jpeg,image/png,image/webp"
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
                        <div className="ev-kv"><span>ai&nbsp;verdict</span><span className={r.verdict === "PASS" ? "ink-lime" : "ink-red"}>{r.verdict} · {r.brain}{r.brain === "0g-compute" && r.teeVerified ? " · TEE ✓" : ""}</span></div>
                        <div className="ev-kv"><span>reason</span><span>{r.reason}</span></div>
                        <div className="ev-kv"><span>evidence</span><span>{r.imageHash.slice(0, 18)}… · {STORAGE_LABEL[r.storageBackend] ?? r.storageBackend}</span></div>
                        {r.txHash && <div className="ev-kv"><span>tx</span><span>{r.txHash.slice(0, 18)}…</span></div>}
                      </div>
                    )}
                  </div>
                </section>
              );
            })}
          </>
        )}

        {health?.worldAppId && health?.worldRpId && rpContext && (
          <IDKitRequestWidget
            open={worldOpen}
            onOpenChange={setWorldOpen}
            app_id={health.worldAppId as `app_${string}`}
            action={health.worldAction ?? "aivy-checkout"}
            rp_context={rpContext}
            allow_legacy_proofs={true}
            // When we live inside Telegram, World App bounces the user
            // straight back into the Mini App after the proof — no manual
            // app-switching. Outside Telegram (plain browser) we omit it so
            // World's default return behavior applies.
            {...(tg?.initData ? { return_to: "https://t.me/aivycheckout_bot" } : {})}
            preset={worldPreset}
            handleVerify={handleWorldVerify}
            onSuccess={() => {
              setWorldOpen(false);
              if (worldResult.current) applyWorldSession(worldResult.current);
            }}
          />
        )}

        {showReceipt && released && checkout && (
          <Receipt
            checkout={checkout}
            results={results}
            thumbs={thumbs}
            releasedAt={releasedAt ?? new Date()}
            tier={tier}
            nullifier={nullifier}
            onClose={() => setShowReceipt(false)}
          />
        )}

        {error && <div className="errorbar reveal">⚠ {error}</div>}

        <footer className="colophon">
          ECRECOVER-VERIFIED VERDICTS · EVIDENCE HASHED ON-CHAIN · RECEIPTS SEALED TO HCS
          <br />HEDERA × 0G × WORLD ID — ETHGLOBAL LISBOA
          {verified && (
            <button className="signout" onClick={signOut} title="Forget this identity and show the World ID flow again">
              ⏻ SIGN OUT · NEW IDENTITY
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

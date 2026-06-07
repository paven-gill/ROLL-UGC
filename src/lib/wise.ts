import crypto from "crypto";
import { createServerClient } from "@/lib/supabase";

export const WISE_BASE = "https://api.transferwise.com";

// --- SCA (Strong Customer Authentication) signing -------------------------
// Wise gates privileged actions (e.g. funding a transfer) behind a signature
// challenge. The flow: call the endpoint, get a 403 with an `x-2fa-approval`
// one-time token (OTT), sign that OTT with our private key, then retry the
// same request with X-Signature + X-2FA-Approval headers.

// Private key is stored base64-encoded in WISE_PRIVATE_KEY so the multi-line
// PEM survives in env files / Vercel. Falls back to a raw PEM if present.
export function getWisePrivateKeyPem(): string | null {
  const raw = process.env.WISE_PRIVATE_KEY?.trim();
  if (!raw) return null;
  if (raw.includes("BEGIN")) return raw.replace(/\\n/g, "\n");
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    if (decoded.includes("BEGIN")) return decoded;
  } catch {}
  return null;
}

export function signWiseOtt(ott: string): string | null {
  const pem = getWisePrivateKeyPem();
  if (!pem) return null;
  try {
    return crypto.createSign("RSA-SHA256").update(ott).sign(pem, "base64");
  } catch {
    return null;
  }
}

// POST a privileged Wise request, transparently answering the SCA challenge.
export async function wiseSignedFetch(
  url: string,
  token: string,
  body: unknown,
): Promise<Response> {
  const doFetch = (extra: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...extra,
      },
      body: JSON.stringify(body),
    });

  const res = await doFetch();
  if (res.status !== 403) return res;

  // SCA challenge — sign the one-time token and retry once.
  const ott = res.headers.get("x-2fa-approval");
  const result = res.headers.get("x-2fa-approval-result");
  if (!ott || result?.toUpperCase() !== "REJECTED") return res;

  const signature = signWiseOtt(ott);
  if (!signature) return res; // no key configured — return the 403 as-is

  return doFetch({ "X-Signature": signature, "X-2FA-Approval": ott });
}

export type WiseProfile = {
  id: number;
  type: string; // "PERSONAL" | "BUSINESS"
  name: string;
};

// Token resolution: Supabase (app_settings) takes priority over the env var.
export async function getWiseToken(): Promise<string | null> {
  try {
    const db = createServerClient();
    const { data } = await db
      .from("app_settings")
      .select("value")
      .eq("key", "wise_api_token")
      .single();
    if (data?.value) return data.value;
  } catch {}
  return process.env.WISE_API_TOKEN ?? null;
}

export function wiseProfileName(p: any): string {
  if (!p) return "";
  if (p.type === "BUSINESS") return p.name ?? p.businessName ?? "";
  return p.fullName ?? `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim();
}

// IMPORTANT: use /v2/profiles. The legacy /v1/profiles does NOT return every
// profile the token can access (it omitted Content Creator Engine Pty Ltd),
// which is why the dashboard was showing the wrong, empty business account.
export async function fetchWiseProfiles(token: string): Promise<any[]> {
  const res = await fetch(`${WISE_BASE}/v2/profiles`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err: any = new Error(`wise_profiles_${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Pick the profile to operate on. There are multiple business profiles under
// this login, so we must target a specific one rather than "first business":
//   1. WISE_PROFILE_ID env var (exact id) — preferred, explicit
//   2. name match (defaults to "Content Creator Engine")
//   3. first business profile, then first profile of any kind
export function pickWiseProfile(profiles: any[]): any {
  const wantId = process.env.WISE_PROFILE_ID?.trim();
  if (wantId) {
    const byId = profiles.find((p) => String(p.id) === wantId);
    if (byId) return byId;
  }
  const wantName = (process.env.WISE_PROFILE_NAME ?? "Content Creator Engine").toLowerCase();
  const byName = profiles.find(
    (p) => p.type === "BUSINESS" && wiseProfileName(p).toLowerCase().includes(wantName),
  );
  if (byName) return byName;

  return profiles.find((p) => p.type === "BUSINESS") ?? profiles[0] ?? null;
}

// --- Transactions / reconciliation ---------------------------------------

export type WiseTransfer = {
  id: string;
  status: string;            // raw Wise status, e.g. "outgoing_payment_sent"
  sourceValue: number;       // amount taken from balance (usually USD)
  sourceCurrency: string;
  targetValue: number;       // amount the recipient receives
  targetCurrency: string;
  recipientId: number | null;
  recipientName: string;     // resolved account holder name
  reference: string | null;
  created: string | null;    // ISO date
};

// Fetch recent transfers for a profile, with recipient names resolved.
export async function fetchWiseTransfers(
  token: string,
  profileId: number,
  limit = 50,
): Promise<WiseTransfer[]> {
  const headers = { Authorization: `Bearer ${token}` };

  // Recipient id -> name map (so we can match transfers to creators by name).
  const nameById = new Map<number, string>();
  try {
    const accRes = await fetch(`${WISE_BASE}/v2/accounts?profileId=${profileId}&size=200`, { headers });
    if (accRes.ok) {
      const data = await accRes.json();
      const list = data.content ?? data;
      for (const a of list) {
        nameById.set(a.id, a.accountHolderName ?? a.name?.fullName ?? "");
      }
    }
  } catch {}

  const res = await fetch(`${WISE_BASE}/v1/transfers?profile=${profileId}&limit=${limit}`, { headers });
  if (!res.ok) {
    const err: any = new Error(`wise_transfers_${res.status}`);
    err.status = res.status;
    throw err;
  }
  const raw = await res.json();
  return (raw as any[]).map((t) => ({
    id: String(t.id),
    status: t.status ?? "unknown",
    sourceValue: t.sourceValue ?? 0,
    sourceCurrency: t.sourceCurrency ?? "",
    targetValue: t.targetValue ?? 0,
    targetCurrency: t.targetCurrency ?? "",
    recipientId: t.targetAccount ?? null,
    recipientName: (t.targetAccount && nameById.get(t.targetAccount)) || "",
    reference: t.details?.reference ?? t.reference ?? null,
    created: t.created ?? null,
  }));
}

// Wise statuses that mean the money actually left (confirmed paid).
const WISE_SENT_STATUSES = new Set(["outgoing_payment_sent", "funds_refunded", "charged_back"]);
const WISE_PENDING_STATUSES = new Set([
  "incoming_payment_waiting", "incoming_payment_initiated", "processing", "funds_converted", "bounced_back",
]);

export type PayoutMatch = {
  status: "confirmed" | "pending" | "cancelled" | "none";
  transferId: string | null;
  amount: number | null;
  currency: string | null;
  created: string | null;
};

function norm(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Match one recorded payout against the list of real Wise transfers.
// Heuristic: recipient name ~ creator name AND amount ~ payout total
// (compared against both the source and target leg to handle conversions).
export function matchPayout(
  creatorName: string,
  payoutAmount: number,
  transfers: WiseTransfer[],
): PayoutMatch {
  const cn = norm(creatorName);
  const amountClose = (v: number) => v > 0 && Math.abs(v - payoutAmount) <= Math.max(1, payoutAmount * 0.02);

  const candidates = transfers.filter((t) => {
    const rn = norm(t.recipientName);
    const nameOk = cn.length > 0 && rn.length > 0 && (rn.includes(cn) || cn.includes(rn));
    const amountOk = amountClose(t.sourceValue) || amountClose(t.targetValue);
    return nameOk && amountOk;
  });
  if (!candidates.length) return { status: "none", transferId: null, amount: null, currency: null, created: null };

  // Prefer a sent transfer, then pending, then most recent.
  const rank = (t: WiseTransfer) =>
    WISE_SENT_STATUSES.has(t.status) ? 0 : WISE_PENDING_STATUSES.has(t.status) ? 1 : t.status === "cancelled" ? 3 : 2;
  candidates.sort((a, b) => rank(a) - rank(b) || (b.created ?? "").localeCompare(a.created ?? ""));
  const best = candidates[0];

  const status = WISE_SENT_STATUSES.has(best.status)
    ? "confirmed"
    : WISE_PENDING_STATUSES.has(best.status)
    ? "pending"
    : best.status === "cancelled"
    ? "cancelled"
    : "pending";

  return {
    status,
    transferId: best.id,
    amount: best.sourceValue || best.targetValue,
    currency: best.sourceCurrency || best.targetCurrency,
    created: best.created,
  };
}

// Convenience: resolve token + target profile in one call.
export async function getWiseTargetProfile(token: string): Promise<WiseProfile | null> {
  const profiles = await fetchWiseProfiles(token);
  const p = pickWiseProfile(profiles);
  if (!p) return null;
  return { id: p.id, type: p.type, name: wiseProfileName(p) };
}

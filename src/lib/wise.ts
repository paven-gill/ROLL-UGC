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

// Per-campaign Wise config. Each brand has its own Wise account, so the token
// and chosen profile live on the campaign row. Falls back to the env vars when a
// campaign hasn't connected its own account yet (or for single-tenant dev).
export async function getWiseConfig(
  campaignId: string | null
): Promise<{ token: string | null; profileId: string | null }> {
  if (campaignId) {
    try {
      const db = createServerClient();
      const { data } = await db
        .from("campaigns")
        .select("wise_api_token, wise_profile_id")
        .eq("id", campaignId)
        .single();
      if (data?.wise_api_token) {
        return { token: data.wise_api_token, profileId: data.wise_profile_id ?? null };
      }
    } catch {}
  }
  return { token: process.env.WISE_API_TOKEN ?? null, profileId: process.env.WISE_PROFILE_ID ?? null };
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

// Pick the profile to operate on. A token can expose multiple profiles, so we
// target a specific one rather than "first business":
//   1. the campaign's stored wise_profile_id (preferred), else WISE_PROFILE_ID env
//   2. name match (defaults to "Content Creator Engine")
//   3. first business profile, then first profile of any kind
export function pickWiseProfile(profiles: any[], preferredId?: string | null): any {
  const wantId = (preferredId ?? process.env.WISE_PROFILE_ID)?.toString().trim();
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
// We use the Activities API (/v1/profiles/{id}/activities), which mirrors the
// real Wise activity feed — individual transfers AND batch payouts, with
// names, amounts and statuses. The older /v1/transfers endpoint omitted batch
// payments and team-member sends, so it didn't match what the user sees.

export type WiseActivity = {
  id: string;
  type: string;              // "TRANSFER" | "BATCH_TRANSFER" | "INTERBALANCE" | ...
  transferId: string | null; // underlying resource id (for TRANSFER)
  name: string;              // recipient / title, HTML stripped
  description: string;       // e.g. "Sent", "Processing", "Cancelled"
  amount: number;            // parsed primary amount
  currency: string;
  incoming: boolean;         // true for money received
  status: string;            // raw: COMPLETED | IN_PROGRESS | CANCELLED | ...
  created: string | null;    // ISO date
};

function stripHtml(s: string): string {
  return (s ?? "").replace(/<[^>]+>/g, "").trim();
}

// Parse Wise's display amount strings: "266 USD", "3,000 USD",
// "<positive>+ 5,993.89 USD</positive>".
function parseWiseAmount(primaryAmount: string): { value: number; currency: string; incoming: boolean } {
  const incoming = /\+/.test(primaryAmount ?? "") || /positive/.test(primaryAmount ?? "");
  const txt = stripHtml(primaryAmount).replace(/,/g, "");
  const m = txt.match(/(-?[\d.]+)\s*([A-Z]{3})/);
  if (!m) return { value: 0, currency: "", incoming };
  return { value: parseFloat(m[1]), currency: m[2], incoming };
}

// Fetch the activity feed for a profile.
export async function fetchWiseActivities(
  token: string,
  profileId: number,
  size = 60,
): Promise<WiseActivity[]> {
  const res = await fetch(`${WISE_BASE}/v1/profiles/${profileId}/activities?size=${size}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err: any = new Error(`wise_activities_${res.status}`);
    err.status = res.status;
    throw err;
  }
  const j = await res.json();
  const items: any[] = j.activities ?? j.content ?? j ?? [];
  return items.map((a) => {
    const amt = parseWiseAmount(a.primaryAmount ?? "");
    return {
      id: String(a.id ?? a.resource?.id ?? ""),
      type: a.type ?? "UNKNOWN",
      transferId: a.resource?.id ? String(a.resource.id) : null,
      name: stripHtml(a.title ?? ""),
      description: stripHtml(a.description ?? ""),
      amount: amt.value,
      currency: amt.currency,
      incoming: amt.incoming,
      status: a.status ?? "UNKNOWN",
      created: a.createdOn ?? null,
    };
  });
}

export type PayoutMatch = {
  status: "confirmed" | "pending" | "cancelled" | "none";
  transferId: string | null;
  amount: number | null;
  currency: string | null;
  created: string | null;
};

function norm(s: string): string {
  // Fold accents first (É -> E) so "Eabha" matches "Éabha", then strip the rest.
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Match one recorded payout against the real Wise activity feed.
// Heuristic: recipient name ~ creator name AND amount ~ payout total.
// Only individual outgoing TRANSFERs are matchable — batch "payouts" show a
// single combined total with no per-creator name, so they can't be matched.
export function matchPayout(
  creatorName: string,
  payoutAmount: number,
  activities: WiseActivity[],
): PayoutMatch {
  const cn = norm(creatorName);
  const amountClose = (v: number) => v > 0 && Math.abs(v - payoutAmount) <= Math.max(1, payoutAmount * 0.02);

  const candidates = activities.filter((a) => {
    if (a.incoming || a.type !== "TRANSFER") return false;
    const rn = norm(a.name);
    const nameOk = cn.length > 0 && rn.length > 0 && (rn.includes(cn) || cn.includes(rn));
    return nameOk && amountClose(a.amount);
  });
  if (!candidates.length) return { status: "none", transferId: null, amount: null, currency: null, created: null };

  // Prefer completed, then in-progress, then most recent.
  const rank = (a: WiseActivity) =>
    a.status === "COMPLETED" ? 0 : a.status === "IN_PROGRESS" ? 1 : a.status === "CANCELLED" ? 3 : 2;
  candidates.sort((a, b) => rank(a) - rank(b) || (b.created ?? "").localeCompare(a.created ?? ""));
  const best = candidates[0];

  const status = best.status === "COMPLETED"
    ? "confirmed"
    : best.status === "IN_PROGRESS"
    ? "pending"
    : best.status === "CANCELLED"
    ? "cancelled"
    : "pending";

  return { status, transferId: best.transferId, amount: best.amount, currency: best.currency, created: best.created };
}

// Convenience: resolve token + target profile in one call.
export async function getWiseTargetProfile(token: string): Promise<WiseProfile | null> {
  const profiles = await fetchWiseProfiles(token);
  const p = pickWiseProfile(profiles);
  if (!p) return null;
  return { id: p.id, type: p.type, name: wiseProfileName(p) };
}

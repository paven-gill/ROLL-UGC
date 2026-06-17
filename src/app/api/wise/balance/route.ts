import { NextResponse } from "next/server";
import { WISE_BASE, getWiseConfig, fetchWiseProfiles, pickWiseProfile, wiseProfileName } from "@/lib/wise";
import { requireAuth, isAuthError } from "@/lib/auth";

export async function GET(req: Request) {
  try {
  const ctx = await requireAuth(req);
  if (!ctx.campaignId) {
    return NextResponse.json({ error: "select_campaign" }, { status: 400 });
  }
  const { token, profileId } = await getWiseConfig(ctx.campaignId);
  if (!token) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const headers = { Authorization: `Bearer ${token}` };

  let profiles: any[];
  try {
    profiles = await fetchWiseProfiles(token);
  } catch (e: any) {
    if (e?.status === 401) return NextResponse.json({ error: "wise_auth_failed" }, { status: 401 });
    return NextResponse.json({ error: "wise_unreachable" }, { status: 502 });
  }

  if (!profiles.length) {
    return NextResponse.json({ error: "no_profiles" }, { status: 404 });
  }

  // Target this campaign's stored Wise profile (falls back to env/business pick).
  const profile = pickWiseProfile(profiles, profileId);
  if (!profile) {
    return NextResponse.json({ error: "no_target_profile" }, { status: 404 });
  }

  let balances: any[] = [];
  try {
    const res = await fetch(`${WISE_BASE}/v4/profiles/${profile.id}/balances?types=STANDARD`, { headers });
    if (!res.ok) {
      return NextResponse.json({ error: "wise_balances_failed" }, { status: 502 });
    }
    const arr = await res.json();
    balances = arr.map((b: any) => ({
      id: b.id,
      currency: b.currency,
      amount: { value: b.amount?.value ?? 0, currency: b.currency },
      name: b.name ?? null,
    }));
  } catch {
    return NextResponse.json({ error: "wise_unreachable" }, { status: 502 });
  }

  return NextResponse.json({
    profile: { id: profile.id, type: profile.type, name: wiseProfileName(profile) },
    balances,
  });
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

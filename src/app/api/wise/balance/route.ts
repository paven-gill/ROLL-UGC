import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

const WISE_BASE = "https://api.transferwise.com";

async function getToken(): Promise<string | null> {
  // Supabase takes priority over env var
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

export async function GET() {
  const token = await getToken();
  if (!token) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const headers = { Authorization: `Bearer ${token}` };

  let profiles: any[];
  try {
    const res = await fetch(`${WISE_BASE}/v1/profiles`, { headers });
    if (!res.ok) {
      return NextResponse.json({ error: "wise_auth_failed" }, { status: 401 });
    }
    profiles = await res.json();
  } catch {
    return NextResponse.json({ error: "wise_unreachable" }, { status: 502 });
  }

  if (!profiles.length) {
    return NextResponse.json({ error: "no_profiles" }, { status: 404 });
  }

  // Fetch balances for all profiles and merge, skipping zero-balance currencies
  // (money may be in personal account even when a business profile exists)
  let allBalances: any[] = [];
  try {
    const results = await Promise.all(
      profiles.map(p =>
        fetch(`${WISE_BASE}/v4/profiles/${p.id}/balances?types=STANDARD`, { headers })
          .then(r => r.ok ? r.json() : [])
          .catch(() => [])
      )
    );
    allBalances = results.flat();
  } catch {
    return NextResponse.json({ error: "wise_unreachable" }, { status: 502 });
  }

  // Merge currencies across profiles: sum amounts for the same currency
  const merged = new Map<string, { id: number; currency: string; amount: { value: number; currency: string }; name: string | null }>();
  for (const b of allBalances) {
    const existing = merged.get(b.currency);
    if (existing) {
      existing.amount.value += b.amount?.value ?? 0;
    } else {
      merged.set(b.currency, { id: b.id, currency: b.currency, amount: { value: b.amount?.value ?? 0, currency: b.currency }, name: b.name ?? null });
    }
  }
  const balances = Array.from(merged.values()).filter(b => b.amount.value > 0 || merged.size <= 1);

  const businessProfile = profiles.find((p: any) => p.type?.toLowerCase() === "business") ?? profiles[0];
  const name = businessProfile.type?.toLowerCase() === "business"
    ? businessProfile.details?.name
    : `${businessProfile.details?.firstName ?? ""} ${businessProfile.details?.lastName ?? ""}`.trim();

  return NextResponse.json({
    profile: { id: businessProfile.id, type: businessProfile.type, name },
    balances,
  });
}

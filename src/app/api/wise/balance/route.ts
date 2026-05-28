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

  const profile = profiles.find((p: any) => p.type?.toLowerCase() === "business") ?? profiles[0];
  if (!profile) {
    return NextResponse.json({ error: "no_profiles" }, { status: 404 });
  }

  let balances: any[];
  try {
    const res = await fetch(
      `${WISE_BASE}/v4/profiles/${profile.id}/balances?types=STANDARD`,
      { headers },
    );
    if (!res.ok) {
      return NextResponse.json({ error: "balance_fetch_failed" }, { status: res.status });
    }
    balances = await res.json();
  } catch {
    return NextResponse.json({ error: "wise_unreachable" }, { status: 502 });
  }

  const name =
    profile.type?.toLowerCase() === "business"
      ? profile.details?.name
      : `${profile.details?.firstName ?? ""} ${profile.details?.lastName ?? ""}`.trim();

  return NextResponse.json({
    profile: { id: profile.id, type: profile.type, name },
    balances,
  });
}

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

const WISE_BASE = "https://api.transferwise.com";

// POST — validate token against Wise then save to Supabase
export async function POST(req: NextRequest) {
  const { token } = await req.json();
  if (!token?.trim()) {
    return NextResponse.json({ error: "token_required" }, { status: 400 });
  }

  // Validate the token by calling Wise
  let profiles: any[];
  try {
    const res = await fetch(`${WISE_BASE}/v1/profiles`, {
      headers: { Authorization: `Bearer ${token.trim()}` },
    });
    if (!res.ok) {
      return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }
    profiles = await res.json();
  } catch {
    return NextResponse.json({ error: "wise_unreachable" }, { status: 502 });
  }

  const profile = profiles.find((p: any) => p.type?.toLowerCase() === "business") ?? profiles[0];
  const name =
    profile?.type === "BUSINESS"
      ? profile.details?.name
      : `${profile?.details?.firstName ?? ""} ${profile?.details?.lastName ?? ""}`.trim();

  // Save to Supabase
  const db = createServerClient();
  await db.from("app_settings").upsert({ key: "wise_api_token", value: token.trim(), updated_at: new Date().toISOString() });

  return NextResponse.json({ connected: true, profile: { id: profile?.id, type: profile?.type, name } });
}

// DELETE — remove token from Supabase
export async function DELETE() {
  const db = createServerClient();
  await db.from("app_settings").delete().eq("key", "wise_api_token");
  return NextResponse.json({ connected: false });
}

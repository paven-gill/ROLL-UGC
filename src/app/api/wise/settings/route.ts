import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { fetchWiseProfiles, pickWiseProfile, wiseProfileName } from "@/lib/wise";

// POST — validate token against Wise then save to Supabase
export async function POST(req: NextRequest) {
  const { token } = await req.json();
  if (!token?.trim()) {
    return NextResponse.json({ error: "token_required" }, { status: 400 });
  }

  // Validate the token by calling Wise (v2/profiles — see lib/wise.ts)
  let profiles: any[];
  try {
    profiles = await fetchWiseProfiles(token.trim());
  } catch (e: any) {
    if (e?.status === 401 || e?.status === 403) {
      return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }
    return NextResponse.json({ error: "wise_unreachable" }, { status: 502 });
  }

  const profile = pickWiseProfile(profiles);

  // Save to Supabase
  const db = createServerClient();
  await db.from("app_settings").upsert({ key: "wise_api_token", value: token.trim(), updated_at: new Date().toISOString() });

  return NextResponse.json({
    connected: true,
    profile: { id: profile?.id, type: profile?.type, name: wiseProfileName(profile) },
  });
}

// DELETE — remove token from Supabase
export async function DELETE() {
  const db = createServerClient();
  await db.from("app_settings").delete().eq("key", "wise_api_token");
  return NextResponse.json({ connected: false });
}

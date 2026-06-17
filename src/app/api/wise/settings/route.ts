import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { fetchWiseProfiles, pickWiseProfile, wiseProfileName } from "@/lib/wise";
import { requireAuth, isAuthError } from "@/lib/auth";

// POST — validate token against Wise then save it on the active campaign
export async function POST(req: NextRequest) {
  try {
  const ctx = await requireAuth(req);
  if (!ctx.campaignId) {
    return NextResponse.json({ error: "select_campaign" }, { status: 400 });
  }
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

  // Save token + chosen profile onto THIS campaign (per-brand Wise account).
  const db = createServerClient();
  await db
    .from("campaigns")
    .update({
      wise_api_token: token.trim(),
      wise_profile_id: profile?.id ? String(profile.id) : null,
    })
    .eq("id", ctx.campaignId);

  return NextResponse.json({
    connected: true,
    profile: { id: profile?.id, type: profile?.type, name: wiseProfileName(profile) },
  });
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

// DELETE — disconnect this campaign's Wise account
export async function DELETE(req: Request) {
  try {
  const ctx = await requireAuth(req);
  if (!ctx.campaignId) {
    return NextResponse.json({ error: "select_campaign" }, { status: 400 });
  }
  const db = createServerClient();
  await db
    .from("campaigns")
    .update({ wise_api_token: null, wise_profile_id: null })
    .eq("id", ctx.campaignId);
  return NextResponse.json({ connected: false });
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

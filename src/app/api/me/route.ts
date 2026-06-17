import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAuth, isAuthError } from "@/lib/auth";

// Returns the caller's profile + the campaigns they may view.
//   super_admin -> all campaigns
//   brand_admin -> only their one campaign
export async function GET(req: Request) {
  try {
    const ctx = await requireAuth(req);
    const db = createServerClient();

    let campaigns;
    if (ctx.isSuperAdmin) {
      const { data } = await db.from("campaigns").select("id, name, slug").order("name");
      campaigns = data ?? [];
    } else {
      const { data } = await db
        .from("campaigns")
        .select("id, name, slug")
        .eq("id", ctx.campaignId ?? "")
        .order("name");
      campaigns = data ?? [];
    }

    return NextResponse.json({
      userId: ctx.userId,
      email: ctx.email,
      role: ctx.role,
      isSuperAdmin: ctx.isSuperAdmin,
      campaignId: ctx.campaignId,
      campaigns,
    });
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

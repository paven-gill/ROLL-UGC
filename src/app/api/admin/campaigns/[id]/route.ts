import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireSuperAdmin, isAuthError } from "@/lib/auth";

// PATCH — rename a campaign (Owner only). { name }
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    await requireSuperAdmin(req);
    const { name } = (await req.json()) as { name?: string };
    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    const db = createServerClient();
    const { error } = await db
      .from("campaigns")
      .update({ name: name.trim() })
      .eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

// DELETE — remove a campaign (Owner only). Blocked while it still has creators or
// assigned managers, so we never orphan data or lock people out.
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    await requireSuperAdmin(req);
    const db = createServerClient();

    const { count: creatorCount } = await db
      .from("creators")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", params.id);
    if ((creatorCount ?? 0) > 0) {
      return NextResponse.json(
        { error: "Remove or reassign this campaign's creators before deleting it." },
        { status: 400 }
      );
    }

    const { count: managerCount } = await db
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", params.id);
    if ((managerCount ?? 0) > 0) {
      return NextResponse.json(
        { error: "Remove this campaign's managers before deleting it." },
        { status: 400 }
      );
    }

    const { error } = await db.from("campaigns").delete().eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

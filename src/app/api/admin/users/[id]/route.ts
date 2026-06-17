import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { createServerClient } from "@/lib/supabase";
import { requireAuth, isAuthError } from "@/lib/auth";

// Load the target profile and authorize the caller to act on it.
//   Owner   → any user.
//   Manager → only Managers in their own campaign (never an Owner).
async function loadTarget(req: Request, id: string) {
  const ctx = await requireAuth(req);
  const db = createServerClient();
  const { data: target } = await db
    .from("profiles")
    .select("id, role, campaign_id")
    .eq("id", id)
    .single();
  if (!target) {
    throw Object.assign(new Error("not_found"), {
      response: NextResponse.json({ error: "User not found" }, { status: 404 }),
    });
  }
  if (!ctx.isSuperAdmin) {
    if (target.role === "super_admin" || target.campaign_id !== ctx.campaignId) {
      throw Object.assign(new Error("forbidden"), {
        response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      });
    }
  }
  return { ctx, db, target };
}

// PATCH — reassign campaign (Owner only) and/or reset password.
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const { ctx, db, target } = await loadTarget(req, params.id);
    const body = (await req.json().catch(() => ({}))) as {
      campaign_id?: string | null;
      resetPassword?: boolean;
    };

    // Owner may move a user to another campaign.
    if (ctx.isSuperAdmin && body.campaign_id !== undefined && target.role !== "super_admin") {
      await db.from("profiles").update({ campaign_id: body.campaign_id || null }).eq("id", target.id);
    }

    let tempPassword: string | undefined;
    if (body.resetPassword) {
      tempPassword = "Brand-" + randomBytes(6).toString("base64").replace(/[^a-zA-Z0-9]/g, "") + "-26";
      const { error } = await db.auth.admin.updateUserById(target.id, { password: tempPassword });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, tempPassword });
  } catch (e: any) {
    if (e?.response) return e.response;
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

// DELETE — remove the user (auth user + profile cascade). Can't delete yourself.
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    const { db, target, ctx } = await loadTarget(req, params.id);
    if (target.id === ctx.userId) {
      return NextResponse.json({ error: "You can't delete your own account." }, { status: 400 });
    }
    // profiles.id references auth.users ON DELETE CASCADE, so this removes both.
    const { error } = await db.auth.admin.deleteUser(target.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.response) return e.response;
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

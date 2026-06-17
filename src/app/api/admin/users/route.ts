import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { createServerClient } from "@/lib/supabase";
import { requireAuth, isAuthError } from "@/lib/auth";

// GET  /api/admin/users — list users.
//        Owner   → all users (every campaign).
//        Manager → only their own campaign's team.
// POST /api/admin/users — create a user with a temp password.
//        Owner   → may assign any campaign / role.
//        Manager → may only add a Manager to their OWN campaign.
export async function GET(req: Request) {
  try {
    const ctx = await requireAuth(req);
    const db = createServerClient();
    let query = db
      .from("profiles")
      .select("id, email, role, campaign_id, created_at, campaigns(name)")
      .order("created_at");
    // Managers only see their own campaign's team.
    if (!ctx.isSuperAdmin) {
      if (!ctx.campaignId) return NextResponse.json([]);
      query = query.eq("campaign_id", ctx.campaignId);
    }
    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const rows = (data ?? []).map((p) => {
      // Supabase types an embedded to-one relation as an array; normalize it.
      const camp = p.campaigns as unknown as
        | { name: string }
        | { name: string }[]
        | null;
      const campaign_name = Array.isArray(camp)
        ? camp[0]?.name ?? null
        : camp?.name ?? null;
      return {
        id: p.id,
        email: p.email,
        role: p.role,
        campaign_id: p.campaign_id,
        campaign_name,
        created_at: p.created_at,
      };
    });
    return NextResponse.json(rows);
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireAuth(req);
    const db = createServerClient();
    const { email, campaign_id, role } = (await req.json()) as {
      email?: string;
      campaign_id?: string | null;
      role?: "super_admin" | "brand_admin";
    };

    if (!email?.trim()) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    // Resolve role + campaign. A Manager can ONLY create another Manager in their
    // own campaign — the client-supplied role/campaign are ignored for them.
    let newRole: "super_admin" | "brand_admin";
    let targetCampaign: string | null | undefined;
    if (ctx.isSuperAdmin) {
      newRole = role === "super_admin" ? "super_admin" : "brand_admin";
      targetCampaign = campaign_id;
    } else {
      newRole = "brand_admin";
      targetCampaign = ctx.campaignId;
    }

    if (newRole === "brand_admin" && !targetCampaign) {
      return NextResponse.json(
        { error: "A manager must be assigned a campaign" },
        { status: 400 }
      );
    }

    // Create the user immediately with a temporary password (email pre-confirmed
    // so they can log in right away). The owner shares this password with them.
    const tempPassword =
      "Brand-" + randomBytes(6).toString("base64").replace(/[^a-zA-Z0-9]/g, "") + "-26";

    const { data: created, error: createErr } = await db.auth.admin.createUser({
      email: email.trim(),
      password: tempPassword,
      email_confirm: true,
    });
    if (createErr || !created?.user) {
      const msg = /registered|already/i.test(createErr?.message ?? "")
        ? "That email already has an account."
        : createErr?.message ?? "Could not create user";
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    // Link the auth user to a role + campaign.
    const { error: profileErr } = await db.from("profiles").insert({
      id: created.user.id,
      email: email.trim(),
      role: newRole,
      campaign_id: newRole === "super_admin" ? null : targetCampaign,
    });
    if (profileErr) {
      // Roll back the orphaned auth user so a retry can succeed.
      await db.auth.admin.deleteUser(created.user.id).catch(() => {});
      return NextResponse.json({ error: profileErr.message }, { status: 500 });
    }

    return NextResponse.json(
      { ok: true, id: created.user.id, email: email.trim(), tempPassword },
      { status: 201 }
    );
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

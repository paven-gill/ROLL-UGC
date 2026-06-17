import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireSuperAdmin, isAuthError } from "@/lib/auth";

// GET  /api/admin/campaigns — list all campaigns (super_admin only)
// POST /api/admin/campaigns — create a campaign { name }
export async function GET(req: Request) {
  try {
    await requireSuperAdmin(req);
    const db = createServerClient();
    const { data, error } = await db
      .from("campaigns")
      .select("id, name, slug, created_at")
      .order("name");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data ?? []);
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

export async function POST(req: Request) {
  try {
    await requireSuperAdmin(req);
    const db = createServerClient();
    const { name } = (await req.json()) as { name?: string };
    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const { data, error } = await db
      .from("campaigns")
      .insert({ name: name.trim(), slug })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data, { status: 201 });
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

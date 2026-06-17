import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAuth, assertCreatorInScope, isAuthError } from "@/lib/auth";

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
  const ctx = await requireAuth(req);
  const db = createServerClient();
  await assertCreatorInScope(db, ctx, params.id);

  const { data: creator, error: cErr } = await db
    .from("creators")
    .select("*")
    .eq("id", params.id)
    .single();

  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 404 });

  const { data: metrics } = await db
    .from("monthly_metrics")
    .select("*")
    .eq("creator_id", params.id)
    .order("year", { ascending: false })
    .order("month", { ascending: false });

  return NextResponse.json({ ...creator, metrics: metrics || [] });
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
  const ctx = await requireAuth(req);
  const db = createServerClient();
  await assertCreatorInScope(db, ctx, params.id);
  const body = await req.json();

  const { data, error } = await db
    .from("creators")
    .update(body)
    .eq("id", params.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
  const ctx = await requireAuth(req);
  const db = createServerClient();
  await assertCreatorInScope(db, ctx, params.id);
  const { error } = await db.from("creators").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const db = createServerClient();

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
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const db = createServerClient();
  const body = await req.json();

  const { data, error } = await db
    .from("creators")
    .update(body)
    .eq("id", params.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const db = createServerClient();
  const { error } = await db.from("creators").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}

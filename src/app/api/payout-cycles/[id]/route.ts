import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

// PATCH /api/payout-cycles/[id]
// Body: { status: "pending" | "paid" }
// Marks a completed payout cycle as paid or resets it to pending.

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const body = await req.json().catch(() => ({}));
  const status = body.status;

  if (status !== "pending" && status !== "paid") {
    return NextResponse.json({ error: "status must be 'pending' or 'paid'" }, { status: 400 });
  }

  const db = createServerClient();
  const { data, error } = await db
    .from("payout_cycles")
    .update({ status })
    .eq("id", params.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

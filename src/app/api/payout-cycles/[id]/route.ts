import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

// PATCH /api/payout-cycles/[id]
// Body: { status?: "pending" | "paid", cycle_start_date?: string, cycle_end_date?: string }
// Marks a completed payout cycle as paid/pending and/or adjusts its dates.

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const body = await req.json().catch(() => ({}));
  const { status, cycle_start_date, cycle_end_date } = body as {
    status?: string;
    cycle_start_date?: string;
    cycle_end_date?: string;
  };

  if (status !== undefined && status !== "pending" && status !== "paid") {
    return NextResponse.json({ error: "status must be 'pending' or 'paid'" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  if (status !== undefined) update.status = status;
  if (cycle_start_date) update.cycle_start_date = cycle_start_date;
  if (cycle_end_date) update.cycle_end_date = cycle_end_date;

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  }

  const db = createServerClient();
  const { data, error } = await db
    .from("payout_cycles")
    .update(update)
    .eq("id", params.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

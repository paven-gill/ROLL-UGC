import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

// PATCH /api/payout-cycles/[id]
// Body: { status?: "pending" | "paid", cycle_start_date?: string, cycle_end_date?: string }
//
// If editing dates (not a status change) and the new end date is still in the future,
// the cycle is re-activated: creator_cycles is updated to these dates, any payout_cycles
// that rolled over after this one are deleted, and this row is removed.

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

  const db = createServerClient();

  const { data: existing, error: fetchError } = await db
    .from("payout_cycles")
    .select("id, creator_id, cycle_start_date, cycle_end_date, start_views")
    .eq("id", params.id)
    .single();

  if (fetchError || !existing) {
    return NextResponse.json({ error: "cycle not found" }, { status: 404 });
  }

  const today = new Date().toISOString().split("T")[0];
  const newEndDate = cycle_end_date ?? existing.cycle_end_date;
  const newStartDate = cycle_start_date ?? existing.cycle_start_date;

  // Re-activation: editing dates to a range that's still current — remove the overlapping
  // active cycle and restore this one as the running cycle.
  if (!status && newEndDate >= today) {
    await db
      .from("creator_cycles")
      .update({
        cycle_start_date: newStartDate,
        cycle_end_date: newEndDate,
        baseline_views: existing.start_views ?? 0,
        updated_at: new Date().toISOString(),
      })
      .eq("creator_id", existing.creator_id);

    // Delete any payout_cycles that were created after this cycle rolled over
    await db
      .from("payout_cycles")
      .delete()
      .eq("creator_id", existing.creator_id)
      .gt("cycle_start_date", existing.cycle_start_date);

    // Delete this row — it's now the active cycle again
    await db.from("payout_cycles").delete().eq("id", params.id);

    return NextResponse.json({
      ok: true,
      reactivated: true,
      cycle_start_date: newStartDate,
      cycle_end_date: newEndDate,
    });
  }

  const update: Record<string, unknown> = {};
  if (status !== undefined) update.status = status;
  if (cycle_start_date) update.cycle_start_date = cycle_start_date;
  if (cycle_end_date) update.cycle_end_date = cycle_end_date;

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  }

  const { data, error } = await db
    .from("payout_cycles")
    .update(update)
    .eq("id", params.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

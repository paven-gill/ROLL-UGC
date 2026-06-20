import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAuth, assertCreatorInScope, isAuthError } from "@/lib/auth";

// PATCH /api/payout-cycles/[id]
// Body: { status?: "pending" | "paid", cycle_start_date?: string, cycle_end_date?: string }
//
// If editing dates (not a status change) and the new end date is still in the future,
// the cycle is re-activated: creator_cycles is updated to these dates and the stamped
// payout_cycles row for this cycle (plus any that rolled over after it) is deleted —
// the cycle is running again, so it has no completed-payout row. Re-rolling is prevented
// by the future end date in creator_cycles, not by the payout row. Already-paid rows are
// preserved. When the cycle's end date passes, the sync re-stamps a fresh payout.

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
  const ctx = await requireAuth(req);
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

  // Scope: the cycle's creator must belong to the caller's campaign.
  await assertCreatorInScope(db, ctx, existing.creator_id);

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

    // Remove this cycle's stamped payout row and any that rolled over after it — the
    // cycle is running again, so it shouldn't appear as a completed payout. Without this,
    // the Payouts tab keeps reading the stale row and the edit looks like it did nothing.
    // Paid rows are kept so we never erase a real payment record.
    await db
      .from("payout_cycles")
      .delete()
      .eq("creator_id", existing.creator_id)
      .gte("cycle_start_date", existing.cycle_start_date)
      .neq("status", "paid");

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
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

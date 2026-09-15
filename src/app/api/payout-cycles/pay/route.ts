import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAuth, assertCreatorInScope, isAuthError } from "@/lib/auth";

// Payments are NOT sent from this app. The retainer + view bonus is paid out as a
// bonus in Trybe; this route only records that it happened — the amount, the date
// it was paid, and an optional Trybe reference tying the cycle to that bonus.

// "YYYY-MM-DD" → an ISO timestamp at midday UTC, so the stored instant renders as
// the same calendar day on both sides of the date line (AU and US display locales).
function paidAtFromDate(dateStr: unknown): string {
  if (typeof dateStr === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Date(`${dateStr}T12:00:00Z`).toISOString();
  }
  return new Date().toISOString();
}

// The `tribe_reference` column arrives via migration 005. Write it separately and
// swallow failures so the pay flow still works if that migration hasn't been run
// yet — same defensive pattern as lib/campaign-caps.ts.
async function saveTribeReference(
  db: ReturnType<typeof createServerClient>,
  cycleId: string | null | undefined,
  reference: string | null,
) {
  if (!cycleId || !reference) return;
  try {
    await db.from("payout_cycles").update({ tribe_reference: reference }).eq("id", cycleId);
  } catch {
    // column missing → reference simply isn't stored
  }
}

// POST /api/payout-cycles/pay
// type: "pending"     — existing payout_cycles row, just update + mark paid
// type: "in_progress" — cycle still in creator_cycles; close it, create record, new cycle, mark paid
export async function POST(req: NextRequest) {
  try {
  const ctx = await requireAuth(req);
  if (!ctx.campaignId) {
    return NextResponse.json({ error: "Select a campaign before recording a payout." }, { status: 400 });
  }
  const body = await req.json();
  const {
    type,
    cycle_id,
    creator_id,
    cycle_start_date,
    cycle_end_date,
    start_views = 0,
    end_views = 0,
    views_earned = 0,
    capped_views_earned = 0,
    base_fee,
    view_bonus,
    bonus_amount = 0,
    bonus_note = "",
    paid_date,
    tribe_reference,
  } = body;

  const db = createServerClient();
  // Ensure the creator being paid actually belongs to the active campaign — so a
  // payout can never be recorded against the wrong brand.
  if (creator_id) await assertCreatorInScope(db, ctx, creator_id);
  const total = parseFloat((base_fee + view_bonus + (bonus_amount ?? 0)).toFixed(2));
  const paidAt = paidAtFromDate(paid_date);
  const reference = typeof tribe_reference === "string" && tribe_reference.trim()
    ? tribe_reference.trim()
    : null;
  let finalCycleId = cycle_id;

  // View counts are NOT NULL in the DB. The destructuring defaults above only
  // cover `undefined`; a creator with no view data (e.g. didn't finish the 30
  // posts, so no view bonus) comes through as explicit `null`. Coalesce to 0 so
  // the payout still goes through at the correct (no-bonus) amount.
  const safeStartViews = start_views ?? 0;
  const safeEndViews = end_views ?? 0;
  const safeViewsEarned = views_earned ?? 0;
  const safeCappedViewsEarned = capped_views_earned ?? 0;

  if (type === "in_progress") {
    // Close the cycle: create payout_cycles record
    const { data: newCycle, error: insertErr } = await db
      .from("payout_cycles")
      .upsert(
        {
          creator_id,
          cycle_start_date,
          cycle_end_date,
          start_views: safeStartViews,
          end_views: safeEndViews,
          views_earned: safeViewsEarned,
          capped_views_earned: safeCappedViewsEarned,
          base_fee,
          view_bonus,
          bonus_amount: bonus_amount ?? 0,
          bonus_note: bonus_note || null,
          payout_amount: total,
          status: "paid",
          paid_at: paidAt,
        },
        { onConflict: "creator_id,cycle_start_date" },
      )
      .select()
      .single();

    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });
    finalCycleId = newCycle.id;

    // Get latest snapshots as new baseline for the next cycle — both the true
    // total and the capped (payable) basis.
    const { data: snaps } = await db
      .from("view_snapshots")
      .select("platform, cumulative_views, capped_cumulative_views")
      .eq("creator_id", creator_id)
      .order("snapshot_date", { ascending: false });

    const byPlatform = new Map<string, number>();
    const cappedByPlatform = new Map<string, number>();
    for (const s of snaps ?? []) {
      if (!byPlatform.has(s.platform)) byPlatform.set(s.platform, s.cumulative_views ?? 0);
      if (!cappedByPlatform.has(s.platform)) cappedByPlatform.set(s.platform, s.capped_cumulative_views ?? 0);
    }
    const newBaseline = Array.from(byPlatform.values()).reduce((a, b) => a + b, 0);
    const newCappedBaseline = Array.from(cappedByPlatform.values()).reduce((a, b) => a + b, 0);

    // Start next cycle from the day after this cycle ended
    const nextStart = new Date(cycle_end_date + "T00:00:00Z");
    nextStart.setDate(nextStart.getDate() + 1);
    const nextEnd = new Date(nextStart);
    nextEnd.setDate(nextEnd.getDate() + 30);

    await db.from("creator_cycles").update({
      cycle_start_date: nextStart.toISOString().split("T")[0],
      cycle_end_date: nextEnd.toISOString().split("T")[0],
      baseline_views: newBaseline,
      baseline_capped_views: newCappedBaseline,
      updated_at: new Date().toISOString(),
    }).eq("creator_id", creator_id);

  } else {
    // Pending: update existing row with bonus + mark paid
    const { error } = await db.from("payout_cycles").update({
      bonus_amount: bonus_amount ?? 0,
      bonus_note: bonus_note || null,
      payout_amount: total,
      status: "paid",
      paid_at: paidAt,
    }).eq("id", cycle_id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await saveTribeReference(db, finalCycleId, reference);

  return NextResponse.json({
    paid: true,
    cycle_id: finalCycleId,
    paid_at: paidAt,
    tribe_reference: reference,
  });
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

// GET /api/creators/[id]/cycles
// Returns active cycle state + completed cycle history for a creator.

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const db = createServerClient();
  const creatorId = params.id;

  const [
    { data: activeCycleRow },
    { data: completedCycles },
    { data: latestSnaps },
    { data: allPosts },
  ] = await Promise.all([
    db.from("creator_cycles")
      .select("creator_id, cycle_start_date, cycle_end_date, baseline_views")
      .eq("creator_id", creatorId)
      .single(),
    db.from("payout_cycles")
      .select("id, cycle_start_date, cycle_end_date, views_earned, payout_amount, base_fee, view_bonus, status")
      .eq("creator_id", creatorId)
      .order("cycle_end_date", { ascending: false }),
    db.from("view_snapshots")
      .select("platform, cumulative_views, snapshot_date, synced_at")
      .eq("creator_id", creatorId)
      .order("snapshot_date", { ascending: false }),
    db.from("post_snapshots")
      .select("taken_at")
      .eq("creator_id", creatorId),
  ]);

  const lastSyncedAt = latestSnaps?.[0]?.synced_at ?? null;
  console.log(`[cycles] creator=${creatorId} activeCycleRow=`, activeCycleRow, `completedCycles=`, completedCycles?.length ?? 0);

  const byPlatform = new Map<string, number>();
  for (const s of (latestSnaps ?? [])) {
    if (!byPlatform.has(s.platform)) byPlatform.set(s.platform, s.cumulative_views ?? 0);
  }
  const currentTotalViews = Array.from(byPlatform.values()).reduce((a, b) => a + b, 0);

  let activeCycle = null;
  if (activeCycleRow) {
    const today = new Date().toISOString().split("T")[0];
    const startDate = activeCycleRow.cycle_start_date;
    const endDate = activeCycleRow.cycle_end_date;
    const notStarted = today < startDate;
    const viewsEarned = notStarted ? 0 : Math.max(0, currentTotalViews - (activeCycleRow.baseline_views ?? 0));
    const daysRemaining = notStarted ? 0 : Math.max(0, Math.ceil(
      (new Date(endDate + "T00:00:00").getTime() - new Date(today + "T00:00:00").getTime()) / 86400000
    ));
    const daysUntilStart = notStarted ? Math.ceil(
      (new Date(startDate + "T00:00:00").getTime() - new Date(today + "T00:00:00").getTime()) / 86400000
    ) : 0;
    const postCount = notStarted ? 0 : (allPosts ?? []).filter(p =>
      p.taken_at &&
      p.taken_at >= startDate &&
      p.taken_at < endDate
    ).length;

    activeCycle = {
      cycle_start_date: startDate,
      cycle_end_date: endDate,
      baseline_views: activeCycleRow.baseline_views,
      views_earned: viewsEarned,
      days_remaining: daysRemaining,
      not_started: notStarted,
      days_until_start: daysUntilStart,
      post_count: postCount,
    };
  }

  const completedRows = (completedCycles ?? [])
    .filter(c => c.cycle_start_date !== activeCycleRow?.cycle_start_date)
    .map(c => {
    const postCount = (allPosts ?? []).filter(p =>
      p.taken_at &&
      p.taken_at >= c.cycle_start_date &&
      p.taken_at < c.cycle_end_date
    ).length;
    return {
      id: c.id as string,
      cycle_start_date: c.cycle_start_date as string,
      cycle_end_date: c.cycle_end_date as string,
      views_earned: c.views_earned as number,
      payout_amount: c.payout_amount as number | null,
      base_fee: c.base_fee as number,
      view_bonus: c.view_bonus as number,
      post_count: postCount,
      status: c.status as "pending" | "paid" | "in_progress",
    };
  });

  // Prepend the active cycle as an in-progress row so it always appears
  const cycleHistory = activeCycle
    ? [
        {
          id: "active",
          cycle_start_date: activeCycle.cycle_start_date,
          cycle_end_date: activeCycle.cycle_end_date,
          views_earned: activeCycle.views_earned,
          payout_amount: null as number | null,
          base_fee: 0,
          view_bonus: 0,
          post_count: activeCycle.post_count,
          status: "in_progress" as const,
        },
        ...completedRows,
      ]
    : completedRows;

  return NextResponse.json({ activeCycle, cycleHistory, lastSyncedAt });
}

// PATCH /api/creators/[id]/cycles
// Adjusts the active cycle start/end date. End date defaults to start + 30 days if not provided.
// Baseline views are looked up from view_snapshots at the new start date.

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const db = createServerClient();
  const creatorId = params.id;
  const { cycle_start_date, cycle_end_date: customEndDate } = await req.json() as { cycle_start_date: string; cycle_end_date?: string };

  if (!cycle_start_date) {
    return NextResponse.json({ error: "cycle_start_date required" }, { status: 400 });
  }

  // Use provided end date or default to start + 30 days
  const startMs = new Date(cycle_start_date + "T00:00:00Z").getTime();
  const endDate = customEndDate ?? new Date(startMs + 30 * 86400000).toISOString().split("T")[0];

  // Find baseline_views from the most recent view_snapshot on or before new start date
  const { data: snaps } = await db
    .from("view_snapshots")
    .select("platform, cumulative_views, snapshot_date")
    .eq("creator_id", creatorId)
    .lte("snapshot_date", cycle_start_date)
    .order("snapshot_date", { ascending: false });

  const byPlatform = new Map<string, number>();
  for (const s of snaps ?? []) {
    if (!byPlatform.has(s.platform)) byPlatform.set(s.platform, s.cumulative_views ?? 0);
  }
  const baseline_views = Array.from(byPlatform.values()).reduce((a, b) => a + b, 0);

  const { error } = await db
    .from("creator_cycles")
    .update({
      cycle_start_date,
      cycle_end_date: endDate,
      baseline_views,
      updated_at: new Date().toISOString(),
    })
    .eq("creator_id", creatorId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, cycle_start_date, cycle_end_date: endDate, baseline_views });
}

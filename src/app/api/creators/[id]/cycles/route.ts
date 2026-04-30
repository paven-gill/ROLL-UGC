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
      .select("platform, cumulative_views, snapshot_date")
      .eq("creator_id", creatorId)
      .order("snapshot_date", { ascending: false }),
    db.from("post_snapshots")
      .select("taken_at")
      .eq("creator_id", creatorId),
  ]);

  const lastSyncedAt = latestSnaps?.[0]?.snapshot_date ?? null;
  console.log(`[cycles] creator=${creatorId} activeCycleRow=`, activeCycleRow, `completedCycles=`, completedCycles?.length ?? 0);

  const byPlatform = new Map<string, number>();
  for (const s of (latestSnaps ?? [])) {
    if (!byPlatform.has(s.platform)) byPlatform.set(s.platform, s.cumulative_views ?? 0);
  }
  const currentTotalViews = Array.from(byPlatform.values()).reduce((a, b) => a + b, 0);

  let activeCycle = null;
  if (activeCycleRow) {
    const viewsEarned = Math.max(0, currentTotalViews - (activeCycleRow.baseline_views ?? 0));
    const today = new Date().toISOString().split("T")[0];
    const endDate = activeCycleRow.cycle_end_date;
    const daysRemaining = Math.max(0, Math.ceil(
      (new Date(endDate + "T00:00:00").getTime() - new Date(today + "T00:00:00").getTime()) / 86400000
    ));
    const postCount = (allPosts ?? []).filter(p =>
      p.taken_at &&
      p.taken_at >= activeCycleRow.cycle_start_date &&
      p.taken_at < activeCycleRow.cycle_end_date
    ).length;

    activeCycle = {
      cycle_start_date: activeCycleRow.cycle_start_date,
      cycle_end_date: activeCycleRow.cycle_end_date,
      baseline_views: activeCycleRow.baseline_views,
      views_earned: viewsEarned,
      days_remaining: daysRemaining,
      post_count: postCount,
    };
  }

  const completedRows = (completedCycles ?? []).map(c => {
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

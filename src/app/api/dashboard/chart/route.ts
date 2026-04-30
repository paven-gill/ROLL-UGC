import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// GET /api/dashboard/chart?months=6[&creator_id=uuid]
//
// Returns last N months of view data from completed payout_cycles,
// bucketed by cycle_end_date's month (the payout grouping rule).
// The current month also includes in-progress cycle estimates.

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const monthCount = Math.min(12, Math.max(1, parseInt(searchParams.get("months") ?? "6", 10)));
  const creatorId = searchParams.get("creator_id") ?? null;

  const now = new Date();

  // Build month periods oldest → newest
  const periods = Array.from({ length: monthCount }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (monthCount - 1 - i), 1);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const firstDay = `${year}-${String(month).padStart(2, "0")}-01`;
    const nm = month === 12 ? 1 : month + 1;
    const ny = month === 12 ? year + 1 : year;
    const nextFirstDay = `${ny}-${String(nm).padStart(2, "0")}-01`;
    return { year, month, firstDay, nextFirstDay, label: `${MONTHS[month - 1]} '${String(year).slice(2)}` };
  });

  const oldestFirstDay = periods[0].firstDay;
  const latestNextFirstDay = periods[periods.length - 1].nextFirstDay;

  const db = createServerClient();

  let completedQ = db.from("payout_cycles")
    .select("creator_id, cycle_end_date, views_earned, payout_amount")
    .gte("cycle_end_date", oldestFirstDay)
    .lt("cycle_end_date", latestNextFirstDay);
  if (creatorId) completedQ = completedQ.eq("creator_id", creatorId);

  let activeQ = db.from("creator_cycles")
    .select("creator_id, cycle_end_date, baseline_views");
  if (creatorId) activeQ = activeQ.eq("creator_id", creatorId);

  let snapsQ = db.from("view_snapshots")
    .select("creator_id, platform, cumulative_views, snapshot_date")
    .order("snapshot_date", { ascending: false });
  if (creatorId) snapsQ = snapsQ.eq("creator_id", creatorId);

  const [{ data: completed }, { data: activeCycles }, { data: latestSnaps }] = await Promise.all([
    completedQ,
    activeQ,
    snapsQ,
  ]);

  // Helper: latest total views across all platforms for a creator
  function latestTotalViews(cid: string): number {
    const snaps = (latestSnaps ?? []).filter(s => s.creator_id === cid);
    const byPlatform = new Map<string, number>();
    for (const s of snaps) {
      if (!byPlatform.has(s.platform)) byPlatform.set(s.platform, s.cumulative_views ?? 0);
    }
    return Array.from(byPlatform.values()).reduce((a, b) => a + b, 0);
  }

  const currentMonthFirstDay = periods[periods.length - 1].firstDay;
  const currentMonthNextFirstDay = periods[periods.length - 1].nextFirstDay;

  const chartData = periods.map(({ firstDay, nextFirstDay, label }) => {
    // Sum views_earned from completed cycles ending in this month
    const cycleViews = (completed ?? [])
      .filter(c => c.cycle_end_date >= firstDay && c.cycle_end_date < nextFirstDay)
      .reduce((s, c) => s + (c.views_earned ?? 0), 0);

    // For the current month, also add in-progress estimates
    let inProgressViews = 0;
    if (firstDay === currentMonthFirstDay) {
      const completedCreatorIds = new Set(
        (completed ?? [])
          .filter(c => c.cycle_end_date >= currentMonthFirstDay && c.cycle_end_date < currentMonthNextFirstDay)
          .map(c => c.creator_id)
      );

      for (const cycle of (activeCycles ?? [])) {
        if (
          cycle.cycle_end_date >= currentMonthFirstDay &&
          cycle.cycle_end_date < currentMonthNextFirstDay &&
          !completedCreatorIds.has(cycle.creator_id)
        ) {
          const current = latestTotalViews(cycle.creator_id);
          inProgressViews += Math.max(0, current - (cycle.baseline_views ?? 0));
        }
      }
    }

    return { name: label, Views: cycleViews + inProgressViews };
  });

  return NextResponse.json(chartData);
}

import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

// GET /api/dashboard/cycles?year=2026&month=5
//
// Returns completed payout_cycles whose cycle_end_date falls in the given month,
// plus in-progress estimates for active cycles that are projected to end this month.
//
// Payout rule: if a cycle ends in month M, it is counted in month M's payouts.

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const year = parseInt(searchParams.get("year") ?? "0", 10);
  const month = parseInt(searchParams.get("month") ?? "0", 10);

  if (!year || month < 1 || month > 12) {
    return NextResponse.json({ error: "Invalid year or month" }, { status: 400 });
  }

  const firstDay = `${year}-${String(month).padStart(2, "0")}-01`;
  const nm = month === 12 ? 1 : month + 1;
  const ny = month === 12 ? year + 1 : year;
  const nextFirstDay = `${ny}-${String(nm).padStart(2, "0")}-01`;

  const db = createServerClient();

  const [
    { data: completed },
    { data: activeCycles },
    { data: latestSnaps },
  ] = await Promise.all([
    // Completed cycles ending in this month
    db.from("payout_cycles")
      .select("*, creators(name, instagram_username, tiktok_username)")
      .gte("cycle_end_date", firstDay)
      .lt("cycle_end_date", nextFirstDay)
      .order("cycle_end_date"),
    // Active cycles projected to end this month (in-progress estimates)
    db.from("creator_cycles")
      .select("*, creators(id, name, instagram_username, tiktok_username, base_fee, rate_per_thousand_views)")
      .gte("cycle_end_date", firstDay)
      .lt("cycle_end_date", nextFirstDay),
    // Latest daily snapshot per creator+platform for current-views calculation
    db.from("view_snapshots")
      .select("creator_id, platform, cumulative_views, snapshot_date")
      .order("snapshot_date", { ascending: false }),
  ]);

  // IDs of creators that already have a COMPLETED cycle in this month
  const completedCreatorIds = new Set((completed ?? []).map(c => c.creator_id));

  // Helper: sum latest cumulative_views across all platforms for a creator
  function latestTotalViews(creatorId: string): number {
    const snaps = (latestSnaps ?? []).filter(s => s.creator_id === creatorId);
    // For each platform, take the most recent snapshot only
    const byPlatform = new Map<string, number>();
    for (const s of snaps) {
      if (!byPlatform.has(s.platform)) byPlatform.set(s.platform, s.cumulative_views ?? 0);
    }
    return Array.from(byPlatform.values()).reduce((a, b) => a + b, 0);
  }

  // In-progress estimates (active cycles ending this month, not yet closed)
  const inProgress = (activeCycles ?? [])
    .filter(c => !completedCreatorIds.has(c.creator_id))
    .flatMap(cycle => {
      const cr = cycle.creators as {
        name: string; instagram_username: string | null; tiktok_username: string | null;
        base_fee: number; rate_per_thousand_views: number;
      } | null;
      if (!cr) return [];

      const currentViews = latestTotalViews(cycle.creator_id);
      const views_so_far = Math.max(0, currentViews - (cycle.baseline_views ?? 0));
      const view_bonus = parseFloat(((views_so_far / 1000) * cr.rate_per_thousand_views).toFixed(2));
      const payout_amount = parseFloat((cr.base_fee + view_bonus).toFixed(2));

      return [{
        id: `active_${cycle.creator_id}`,
        creator_id: cycle.creator_id,
        creator_name: cr.name,
        instagram_username: cr.instagram_username,
        tiktok_username: cr.tiktok_username,
        cycle_start_date: cycle.cycle_start_date,
        cycle_end_date: cycle.cycle_end_date,
        start_views: cycle.baseline_views,
        end_views: null as number | null,
        views_earned: views_so_far,
        base_fee: cr.base_fee,
        view_bonus,
        payout_amount,
        status: "in_progress" as const,
      }];
    });

  // Shape completed cycles
  const completedRows = (completed ?? []).map(c => {
    const cr = c.creators as { name: string; instagram_username: string | null; tiktok_username: string | null } | null;
    return {
      id: c.id as string,
      creator_id: c.creator_id as string,
      creator_name: cr?.name ?? "Unknown",
      instagram_username: cr?.instagram_username ?? null,
      tiktok_username: cr?.tiktok_username ?? null,
      cycle_start_date: c.cycle_start_date as string,
      cycle_end_date: c.cycle_end_date as string,
      start_views: c.start_views as number,
      end_views: c.end_views as number,
      views_earned: c.views_earned as number,
      base_fee: c.base_fee as number,
      view_bonus: c.view_bonus as number,
      payout_amount: c.payout_amount as number,
      status: c.status as "pending" | "paid",
    };
  });

  return NextResponse.json([...completedRows, ...inProgress]);
}

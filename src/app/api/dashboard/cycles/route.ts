import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAuth, allowedCreatorIds, isAuthError } from "@/lib/auth";
import { fetchAllRows } from "@/lib/fetch-all";
import { loadCampaignViewCaps } from "@/lib/campaign-caps";
import { applyCycleViewCap } from "@/lib/constants";

// GET /api/dashboard/cycles?year=2026&month=5
//
// Returns completed payout_cycles whose cycle_end_date falls in the given month,
// plus in-progress estimates for active cycles that are projected to end this month.
//
// Payout rule: if a cycle ends in month M, it is counted in month M's payouts.

export async function GET(req: Request) {
  try {
  const ctx = await requireAuth(req);
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
  const ids = await allowedCreatorIds(db, ctx);

  // Completed cycles ending in this month (pending = to pay, paid = already paid)
  const completedQ = db.from("payout_cycles")
    .select("*, creators(name, instagram_username, tiktok_username, monthly_target)")
    .gte("cycle_end_date", firstDay)
    .lt("cycle_end_date", nextFirstDay)
    .order("cycle_end_date");
  // Active cycles ending in this month (for in-progress estimates)
  const activeQ = db.from("creator_cycles")
    .select("*, creators(id, name, instagram_username, tiktok_username, base_fee, rate_per_thousand_views, campaign_id, active, status, monthly_target)")
    .gte("cycle_end_date", firstDay)
    .lt("cycle_end_date", nextFirstDay);
  // Every creator's current active-cycle start (any month) — used to drop superseded
  // stamps below. Kept separate from activeQ, which is month-scoped, because a stale
  // stamp can fall in this month while its (edited) running cycle ends in another.
  const activeStartsQ = db.from("creator_cycles")
    .select("creator_id, cycle_start_date");
  // Latest daily snapshot per creator+platform for current-views calculation.
  // True views are displayed; the capped series drives the payout estimate.
  const snapsQ = db.from("view_snapshots")
    .select("creator_id, platform, cumulative_views, capped_cumulative_views, snapshot_date")
    .order("snapshot_date", { ascending: false });
  // Campaign scope: constrain each creator-keyed query unless super_admin viewing all.
  if (ids !== null) {
    completedQ.in("creator_id", ids);
    activeQ.in("creator_id", ids);
    activeStartsQ.in("creator_id", ids);
    snapsQ.in("creator_id", ids);
  }

  const [
    { data: completedRaw },
    { data: activeCycles },
    { data: activeStarts },
    { data: latestSnaps },
    viewCaps,
  ] = await Promise.all([completedQ, activeQ, activeStartsQ, snapsQ, loadCampaignViewCaps(db)]);

  // A stamped payout whose start matches the creator's CURRENT active-cycle start is a
  // superseded leftover: the cycle was stamped on completion, then its dates were edited
  // so it's running again (same start, later end). The creator detail page already hides
  // these (it filters completed cycles by active start); mirror that here so the Payouts
  // tab shows the live in-progress cycle instead of the stale stamp. When the running
  // cycle truly ends, the sync re-stamps this same row (upsert on creator_id+start) with
  // the corrected end date, and it reappears here as a real completed payout.
  const activeStartByCreator = new Map<string, string>();
  for (const c of activeStarts ?? []) activeStartByCreator.set(c.creator_id, c.cycle_start_date);
  const completed = (completedRaw ?? []).filter(
    c => activeStartByCreator.get(c.creator_id) !== c.cycle_start_date
  );

  // Posts made within each cycle window, for the Posts/target progress column. The
  // sync deletes+reinserts post_snapshots, so there's one row per post and a count of
  // rows whose taken_at lands in [start, end) is the post count. Paged to dodge
  // Supabase's 1000-row cap, lower-bounded ~120 days before the month so a cycle that
  // ends this month (≤ ~31 days, longer if hand-edited) is fully covered while pages
  // stay small.
  const postsLowerBound = new Date(new Date(firstDay + "T00:00:00Z").getTime() - 120 * 86400000)
    .toISOString().split("T")[0];
  const postRows = await fetchAllRows<{ creator_id: string; taken_at: string | null }>(
    (from, to) => {
      const q = db.from("post_snapshots")
        .select("creator_id, taken_at")
        .gte("taken_at", postsLowerBound)
        .order("taken_at")
        .range(from, to);
      if (ids !== null) q.in("creator_id", ids);
      return q;
    }
  );
  // taken_at is an ISO timestamp; it compares correctly against YYYY-MM-DD bounds
  // (mirrors the creator detail page's per-cycle post count).
  const postsInCycle = (creatorId: string, start: string, end: string): number =>
    postRows.filter(p => p.creator_id === creatorId && p.taken_at && p.taken_at >= start && p.taken_at < end).length;

  // Helper: sum latest views across all platforms for a creator. `capped=true`
  // returns the payable basis; otherwise the true total.
  const latestViews = (creatorId: string, capped: boolean): number => {
    const snaps = (latestSnaps ?? []).filter(s => s.creator_id === creatorId);
    const byPlatform = new Map<string, number>();
    for (const s of snaps) {
      const v = capped ? (s.capped_cumulative_views ?? 0) : (s.cumulative_views ?? 0);
      if (!byPlatform.has(s.platform)) byPlatform.set(s.platform, v);
    }
    return Array.from(byPlatform.values()).reduce((a, b) => a + b, 0);
  };

  // A stamped payout for this month is the authoritative figure for that creator —
  // don't also show their (new) running cycle as an in-progress estimate for the same month.
  const completedCreatorIds = new Set((completed ?? []).map(c => c.creator_id));

  // In-progress estimates — active cycles ending this month, minus already-stamped creators
  const inProgress = (activeCycles ?? [])
    .flatMap(cycle => {
      const cr = cycle.creators as {
        name: string; instagram_username: string | null; tiktok_username: string | null;
        base_fee: number; rate_per_thousand_views: number; campaign_id: string | null;
        active: boolean | null; status: "active" | "paused" | "finished" | null;
        monthly_target: number | null;
      } | null;
      if (!cr) return [];
      if (completedCreatorIds.has(cycle.creator_id)) return [];
      // Paused / finished creators aren't running cycles anymore — don't project
      // their frozen cycle as an upcoming payout. (Stamped pending/paid cycles
      // still appear above, since those are real amounts owed or already paid.)
      if (cr.active === false || cr.status === "paused" || cr.status === "finished") return [];

      // Displayed views earned use the true series; the payout uses the capped one.
      const views_so_far = Math.max(0, latestViews(cycle.creator_id, false) - (cycle.baseline_views ?? 0));
      const capped_so_far = Math.max(0, latestViews(cycle.creator_id, true) - (cycle.baseline_capped_views ?? 0));
      // Apply the campaign's per-cycle payout ceiling (e.g. Roll caps at 1M views).
      const payable_so_far = applyCycleViewCap(capped_so_far, viewCaps.get(cr.campaign_id ?? "") ?? null);
      const view_bonus = parseFloat(((payable_so_far / 1000) * cr.rate_per_thousand_views).toFixed(2));
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
        capped_views_earned: capped_so_far,
        base_fee: cr.base_fee,
        view_bonus,
        payout_amount,
        post_count: postsInCycle(cycle.creator_id, cycle.cycle_start_date, cycle.cycle_end_date),
        posts_target: cr.monthly_target ?? 30,
        status: "in_progress" as const,
      }];
    });

  // Shape completed cycles ending in this month (both pending and paid)
  const completedRows = (completed ?? []).map(c => {
    const cr = c.creators as { name: string; instagram_username: string | null; tiktok_username: string | null; monthly_target: number | null } | null;
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
      capped_views_earned: c.capped_views_earned as number,
      base_fee: c.base_fee as number,
      view_bonus: c.view_bonus as number,
      payout_amount: c.payout_amount as number,
      post_count: postsInCycle(c.creator_id as string, c.cycle_start_date as string, c.cycle_end_date as string),
      posts_target: cr?.monthly_target ?? 30,
      status: c.status as "pending" | "paid",
    };
  });

  const all = [...completedRows, ...inProgress].sort((a, b) =>
    a.cycle_start_date.localeCompare(b.cycle_start_date)
  );
  return NextResponse.json(all);
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

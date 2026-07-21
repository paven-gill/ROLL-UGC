import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { businessDate, addDays } from "@/lib/date";
import { fetchAllRows } from "@/lib/fetch-all";
import { requireAuth, allowedCreatorIds, scopeToCreators, isAuthError } from "@/lib/auth";

// Days of snapshots to fetch BEFORE the window baseline, so the baseline lookup
// can fall back to the nearest prior snapshot even across a skipped sync.
const BASELINE_BUFFER_DAYS = 14;

// GET /api/dashboard/range?days=30
// OR  /api/dashboard/range?year=2026&month=5
//
// Returns per-creator views gained over the requested window, computed as a
// cumulative-snapshot delta (endViews - baselineViews). Both modes use the same
// calendar-delta logic so the Home stat cards always match the Views-Over-Time
// chart (which uses the same per-day snapshot deltas).
//
//  - days mode:  window = [today - days, today]
//  - month mode: window = [first of month, min(last of month, today)];
//                baseline = cumulative views at the end of the previous month.

function isoDate(y: number, mZeroBased: number, d: number): string {
  return new Date(Date.UTC(y, mZeroBased, d)).toISOString().split("T")[0];
}

export async function GET(req: Request) {
  try {
  const ctx = await requireAuth(req);
  const { searchParams } = new URL(req.url);
  const yearParam = searchParams.get("year");
  const monthParam = searchParams.get("month");

  const todayStr = businessDate();

  // Resolve the window: baselineDate (exclusive lower bound — cumulative views
  // as of this date are the starting point) and endDate (inclusive upper bound).
  let baselineDate: string;
  let endDate: string;

  if (yearParam && monthParam) {
    const year = parseInt(yearParam, 10);
    const month = parseInt(monthParam, 10); // 1-12
    // Last day of the selected month, capped at today (don't count future days).
    const lastOfMonth = isoDate(year, month, 0); // day 0 of next month = last of this month
    endDate = lastOfMonth < todayStr ? lastOfMonth : todayStr;
    // Baseline = the last day of the previous month, so the delta captures only
    // views gained within this calendar month.
    baselineDate = isoDate(year, month - 1, 0);
  } else {
    const days = Math.min(90, Math.max(1, parseInt(searchParams.get("days") || "30", 10)));
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    baselineDate = businessDate(cutoff);
    endDate = todayStr;
  }

  const db = createServerClient();
  const ids = await allowedCreatorIds(db, ctx);

  const creatorsQ = db.from("creators")
    .select("id, name, instagram_username, tiktok_username, base_fee, rate_per_thousand_views")
    .order("name");

  // Base retainers are attributed to the date a cycle COMPLETES (cycle_end_date),
  // matching the view-bonus accrual clock and the chart's "Cycle complete" dots.
  // Count completed cycles (pending or paid) whose end date falls strictly after
  // the baseline and on/before the window end — same boundary semantics as the
  // cumulative-views delta (baseline exclusive, end inclusive).
  // Fetch only [baseline - buffer, endDate], paged past Supabase's 1000-row
  // cap. The previous unbounded ascending query silently dropped the newest
  // snapshots once the table passed 1000 rows, under-counting recent windows.
  const snapFetchLower = addDays(baselineDate, -BASELINE_BUFFER_DAYS);
  const snapshotsPromise = fetchAllRows<{
    creator_id: string;
    platform: string;
    cumulative_views: number | null;
    capped_cumulative_views: number | null;
    post_count_30d: number | null;
    snapshot_date: string;
  }>((from, to) =>
    scopeToCreators(
      db.from("view_snapshots")
        .select("creator_id, platform, cumulative_views, capped_cumulative_views, post_count_30d, snapshot_date")
        .gte("snapshot_date", snapFetchLower)
        .lte("snapshot_date", endDate)
        .order("snapshot_date", { ascending: true })
        .range(from, to),
      ids,
    ),
  );

  const [{ data: creators }, snapshots, { data: completedCycles }, { data: activeCycles }] =
    await Promise.all([
      ids === null ? creatorsQ : creatorsQ.in("id", ids),
      snapshotsPromise,
      scopeToCreators(db.from("payout_cycles")
        .select("creator_id, cycle_start_date, cycle_end_date, base_fee, status")
        .gt("cycle_end_date", baselineDate)
        .lte("cycle_end_date", endDate)
        .in("status", ["pending", "paid"]), ids),
      scopeToCreators(db.from("creator_cycles").select("creator_id, cycle_start_date"), ids),
    ]);

  if (!creators) return NextResponse.json({ results: [], windowAccurate: false });

  // A payout_cycles row whose start matches the creator's current active cycle is
  // really the in-progress cycle, not a completed one — don't count its base
  // (mirrors the payout-events route so Home agrees with the creator page).
  const activeStartByCreator = new Map<string, string>();
  for (const ac of activeCycles ?? []) {
    activeStartByCreator.set(ac.creator_id as string, ac.cycle_start_date as string);
  }
  const baseByCreator = new Map<string, number>();
  for (const c of completedCycles ?? []) {
    if (activeStartByCreator.get(c.creator_id as string) === c.cycle_start_date) continue;
    baseByCreator.set(
      c.creator_id as string,
      (baseByCreator.get(c.creator_id as string) ?? 0) + (c.base_fee ?? 0),
    );
  }

  // Build per creator+platform ascending lists for nearest-prior lookups.
  // `views` is the TRUE total (displayed); `capped` is the payable basis (payout).
  type Snap = { date: string; views: number; capped: number; posts: number };
  const byCombo = new Map<string, Snap[]>();
  for (const s of snapshots || []) {
    const k = `${s.creator_id}|${s.platform}`;
    if (!byCombo.has(k)) byCombo.set(k, []);
    byCombo.get(k)!.push({
      date: s.snapshot_date,
      views: s.cumulative_views ?? 0,
      capped: s.capped_cumulative_views ?? 0,
      posts: s.post_count_30d ?? 0,
    });
  }

  // Most recent snapshot at/before targetDate (lists are date-ascending).
  const atOrBefore = (combo: string, targetDate: string): Snap | undefined => {
    const arr = byCombo.get(combo);
    if (!arr) return undefined;
    let r: Snap | undefined;
    for (const s of arr) { if (s.date <= targetDate) r = s; else break; }
    return r;
  };

  // windowAccurate = true only if every tracked creator+platform had a snapshot
  // at/before the baseline date (otherwise we fall back to the earliest snapshot,
  // which can over-count because it predates the window start).
  let windowAccurate = true;

  const results = creators.map(creator => {
    let ig_views = 0, tt_views = 0, ig_posts = 0, tt_posts = 0;
    // Capped (payable) deltas, used for payout only — never displayed.
    let capped_views = 0;

    for (const platform of ["instagram", "tiktok"] as const) {
      const combo = `${creator.id}|${platform}`;
      const arr = byCombo.get(combo);
      if (!arr || arr.length === 0) continue;

      const end = atOrBefore(combo, endDate);
      if (!end) continue; // no snapshot within/before the window — nothing to show

      // Baseline = cumulative views as of baselineDate. Fall back to the earliest
      // snapshot when none exists yet (e.g. creator started mid-window).
      const baselineSnap = atOrBefore(combo, baselineDate);
      if (!baselineSnap) windowAccurate = false;
      const baseline = baselineSnap ?? arr[0];

      const sameDay = baseline.date === end.date;
      const views = sameDay ? 0 : Math.max(0, end.views - baseline.views);
      const cappedDelta = sameDay ? 0 : Math.max(0, end.capped - baseline.capped);
      capped_views += cappedDelta;

      if (platform === "instagram") {
        ig_views = views;
        ig_posts = end.posts;
      } else {
        tt_views = views;
        tt_posts = end.posts;
      }
    }

    const total_views = ig_views + tt_views;
    const total_posts = ig_posts + tt_posts;
    // Payout is on capped views; total_views (true) stays the displayed figure.
    // NOTE: the per-campaign payout ceiling (campaigns.monthly_view_cap) is applied
    // per CYCLE, at the authoritative payout paths (cycle close + the Payouts-page
    // estimate). It is intentionally NOT applied here: this window is arbitrary
    // (7/14/30d, a month, or all-time) and can span multiple cycles, so a single
    // min(capped, cap) would wrongly cap multi-cycle earnings. This Home figure is
    // a live estimate of view value, not the money owed — the Payouts/Finance pages
    // are the source of truth for capped amounts actually paid.
    const payout = (capped_views / 1000) * creator.rate_per_thousand_views;

    return {
      id: creator.id,
      name: creator.name,
      instagram_username: creator.instagram_username,
      tiktok_username: creator.tiktok_username,
      base_fee: creator.base_fee,
      rate_per_thousand_views: creator.rate_per_thousand_views,
      ig_views, tt_views, total_views,
      ig_posts, tt_posts, total_posts,
      payout,
      base_total: baseByCreator.get(creator.id) ?? 0,
    };
  });

  return NextResponse.json({ results, windowAccurate });
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

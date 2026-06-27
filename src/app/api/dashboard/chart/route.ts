import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { businessDate, addDays } from "@/lib/date";
import { fetchAllRows } from "@/lib/fetch-all";
import { requireAuth, allowedCreatorIds, scopeToCreators, isAuthError } from "@/lib/auth";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Days of snapshots to fetch BEFORE the window baseline, so the first month's
// delta can find its prior-month baseline even across a skipped sync.
const BASELINE_BUFFER_DAYS = 14;

// GET /api/dashboard/chart?months=6[&creator_id=uuid]
//
// Returns last N months of view data, bucketed by calendar month, computed as
// cumulative-snapshot deltas (end-of-month views − end-of-prev-month views) per
// creator+platform. This is the SAME source and logic as the range stat cards
// and the daily chart-range, so the 12 monthly values telescope to
// (latest cumulative − cumulative N months ago) — i.e. the area under the curve
// matches the TOTAL VIEWS card. (Previously this bucketed payout_cycles by
// cycle_end_date, a separate pipeline that misfiled/undercounted views — the
// same reason the stat cards were migrated off it. See page.tsx range note.)

export async function GET(req: Request) {
  try {
  const ctx = await requireAuth(req);
  const { searchParams } = new URL(req.url);
  const monthCount = Math.min(12, Math.max(1, parseInt(searchParams.get("months") ?? "6", 10)));
  const creatorId = searchParams.get("creator_id") ?? null;

  // Anchor "today" to the business calendar day so the latest sync isn't clipped
  // when the cron runs just before UTC midnight (see lib/date.ts).
  const todayStr = businessDate();
  const [ty, tm] = todayStr.split("-").map(Number);

  // Build month periods oldest → newest. lastDay is the last calendar day to
  // count for the month; for the current month it lands in the future, and the
  // at-or-before lookup naturally caps it at the latest available snapshot.
  // Date normalization handles month/year underflow.
  const periods = Array.from({ length: monthCount }, (_, i) => {
    const d = new Date(ty, (tm - 1) - (monthCount - 1 - i), 1);
    const year = d.getFullYear();
    const mIdx = d.getMonth(); // 0-based
    const firstDay = `${year}-${String(mIdx + 1).padStart(2, "0")}-01`;
    const next = new Date(year, mIdx + 1, 1);
    const nextFirstDay = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`;
    return {
      prevMonthLastDay: addDays(firstDay, -1),  // baseline date for this month
      lastDay: addDays(nextFirstDay, -1),        // end date for this month
      label: `${MONTHS[mIdx]} '${String(year).slice(2)}`,
    };
  });

  const db = createServerClient();
  const ids = await allowedCreatorIds(db, ctx);

  // Fetch only the visible window (plus a small baseline buffer), paged past
  // Supabase's 1000-row cap so the newest snapshots aren't silently dropped.
  const fetchLowerBound = addDays(periods[0].prevMonthLastDay, -BASELINE_BUFFER_DAYS);
  const snapshots = await fetchAllRows<{
    creator_id: string;
    platform: string;
    cumulative_views: number | null;
    snapshot_date: string;
  }>((from, to) => {
    let q = db
      .from("view_snapshots")
      .select("creator_id, platform, cumulative_views, snapshot_date")
      .gte("snapshot_date", fetchLowerBound)
      .lte("snapshot_date", periods[periods.length - 1].lastDay)
      .order("snapshot_date", { ascending: true })
      .range(from, to);
    if (creatorId) q = q.eq("creator_id", creatorId);
    return scopeToCreators(q, ids);
  });

  // Build per creator+platform ascending lists for nearest-prior lookups.
  const byCombo = new Map<string, Array<{ date: string; views: number }>>();
  for (const s of snapshots ?? []) {
    const k = `${s.creator_id}|${s.platform}`;
    if (!byCombo.has(k)) byCombo.set(k, []);
    byCombo.get(k)!.push({ date: s.snapshot_date, views: s.cumulative_views ?? 0 });
  }
  const comboList = Array.from(byCombo.keys());

  // Most recent cumulative_views at/before targetDate (lists are date-ascending).
  const atOrBefore = (combo: string, targetDate: string): { date: string; views: number } | undefined => {
    const arr = byCombo.get(combo);
    if (!arr) return undefined;
    let r: { date: string; views: number } | undefined;
    for (const s of arr) { if (s.date <= targetDate) r = s; else break; }
    return r;
  };

  const chartData = periods.map(({ prevMonthLastDay, lastDay, label }) => {
    let views = 0;
    for (const combo of comboList) {
      const end = atOrBefore(combo, lastDay);
      if (!end) continue; // no snapshot in/before this month yet
      // Baseline = cumulative as of end of previous month. Fall back to the
      // creator's earliest snapshot when none exists (started mid-window) —
      // mirrors the range card so the pre-tracking baseline isn't counted.
      const baseline = atOrBefore(combo, prevMonthLastDay) ?? byCombo.get(combo)![0];
      if (baseline.date === end.date) continue; // no movement within the month
      views += Math.max(0, end.views - baseline.views);
    }
    return { name: label, Views: views };
  });

  return NextResponse.json(chartData, {
    headers: { "Cache-Control": "no-store" },
  });
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

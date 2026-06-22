import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { businessDate, addDays } from "@/lib/date";
import { fetchAllRows } from "@/lib/fetch-all";
import { requireAuth, allowedCreatorIds, scopeToCreators, isAuthError } from "@/lib/auth";

// Days of snapshots to fetch BEFORE the visible window, so the first day's
// delta can find its prior-day baseline even if a sync was skipped. Daily syncs
// make 1 day enough; 14 absorbs any realistic gap while keeping the fetch small.
const BASELINE_BUFFER_DAYS = 14;

// GET /api/dashboard/chart-range?days=14[&creator_id=uuid]
// OR  /api/dashboard/chart-range?year=2026&month=4[&creator_id=uuid]
//
// Returns per-day views earned (cumulative snapshot delta) for the requested period.
// Each point = views gained that day across all platforms (and all creators unless filtered).

function prevDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().split("T")[0];
}

function dateLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export async function GET(req: Request) {
  try {
  const ctx = await requireAuth(req);
  const { searchParams } = new URL(req.url);
  const creatorId = searchParams.get("creator_id") ?? null;

  // Anchor "today" to the business calendar day so the latest sync isn't clipped
  // when the cron runs just before UTC midnight (see lib/date.ts).
  const todayStr = businessDate();
  const [ty, tm, td] = todayStr.split("-").map(Number);
  let dates: string[] = [];

  const daysParam  = searchParams.get("days");
  const yearParam  = searchParams.get("year");
  const monthParam = searchParams.get("month");

  if (daysParam) {
    const days = Math.min(90, Math.max(1, parseInt(daysParam, 10)));
    dates = Array.from({ length: days }, (_, i) => {
      const d = new Date(Date.UTC(ty, tm - 1, td - (days - 1 - i)));
      return d.toISOString().split("T")[0];
    });
  } else if (yearParam && monthParam) {
    const year  = parseInt(yearParam,  10);
    const month = parseInt(monthParam, 10);
    const daysInMonth = new Date(year, month, 0).getDate();
    dates = Array.from({ length: daysInMonth }, (_, i) => {
      const day = i + 1;
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    });
  } else {
    return NextResponse.json({ error: "Provide days or year+month" }, { status: 400 });
  }

  if (dates.length === 0) return NextResponse.json([]);

  const lastDate = dates[dates.length - 1];

  const db = createServerClient();
  const ids = await allowedCreatorIds(db, ctx);

  // Fetch only the visible window (plus a small baseline buffer), and PAGE
  // through it. A bare `.select()` is capped at 1000 rows by Supabase; with the
  // ascending sort that silently drops the newest snapshots once the table
  // passes 1000 rows, which made "today" render as zero. The lower bound keeps
  // each request small so the dashboard stays fast as history accumulates.
  const fetchLowerBound = addDays(dates[0], -BASELINE_BUFFER_DAYS);
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
      .lte("snapshot_date", lastDate)
      .order("snapshot_date", { ascending: true })
      .range(from, to);
    if (creatorId) q = q.eq("creator_id", creatorId);
    return scopeToCreators(q, ids);
  });

  // Exact lookup: "creator_id|platform|date" => cumulative_views
  const snapMap = new Map<string, number>();
  // Sorted list per combo for nearest-prior fallback
  const snapsByCombo = new Map<string, Array<{ date: string; views: number }>>();
  for (const s of (snapshots ?? [])) {
    const combo = `${s.creator_id}|${s.platform}`;
    const views = s.cumulative_views ?? 0;
    snapMap.set(`${combo}|${s.snapshot_date}`, views);
    if (!snapsByCombo.has(combo)) snapsByCombo.set(combo, []);
    snapsByCombo.get(combo)!.push({ date: s.snapshot_date, views });
  }

  const comboList = Array.from(snapsByCombo.keys());

  // Returns the most recent cumulative_views at or before targetDate, or undefined
  const latestAtOrBefore = (combo: string, targetDate: string): number | undefined => {
    const snaps = snapsByCombo.get(combo);
    if (!snaps) return undefined;
    let result: number | undefined;
    for (const s of snaps) {
      if (s.date <= targetDate) result = s.views;
      else break;
    }
    return result;
  };

  const chartData = dates.map(date => {
    const pd = prevDay(date);
    let totalViews = 0;
    for (const combo of comboList) {
      const curr = snapMap.get(`${combo}|${date}`);
      if (curr === undefined) continue;
      const prev = latestAtOrBefore(combo, pd) ?? 0;
      totalViews += Math.max(0, curr - prev);
    }
    return { name: dateLabel(date), Views: totalViews };
  });

  return NextResponse.json(chartData, {
    headers: { "Cache-Control": "no-store" },
  });
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

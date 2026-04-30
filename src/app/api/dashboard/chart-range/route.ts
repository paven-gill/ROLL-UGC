import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

// GET /api/dashboard/chart-range?days=14[&creator_id=uuid]
// OR  /api/dashboard/chart-range?year=2026&month=4[&creator_id=uuid]
//
// Returns per-day views earned (cumulative snapshot delta) for the requested period.
// Each point = views gained that day across all platforms (and all creators unless filtered).

function prevDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return dt.toISOString().split("T")[0];
}

function dateLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const creatorId = searchParams.get("creator_id") ?? null;

  const now = new Date();
  let dates: string[] = [];

  const daysParam  = searchParams.get("days");
  const yearParam  = searchParams.get("year");
  const monthParam = searchParams.get("month");

  if (daysParam) {
    const days = Math.min(90, Math.max(1, parseInt(daysParam, 10)));
    dates = Array.from({ length: days }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1 - i));
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

  const firstPrevDay = prevDay(dates[0]);
  const lastDate     = dates[dates.length - 1];

  const db = createServerClient();

  let q = db
    .from("view_snapshots")
    .select("creator_id, platform, cumulative_views, snapshot_date")
    .gte("snapshot_date", firstPrevDay)
    .lte("snapshot_date", lastDate)
    .order("snapshot_date", { ascending: true });
  if (creatorId) q = q.eq("creator_id", creatorId);

  const { data: snapshots } = await q;

  // Index: "creator_id|platform|date" => cumulative_views
  const snapMap = new Map<string, number>();
  const combos  = new Set<string>();
  for (const s of (snapshots ?? [])) {
    snapMap.set(`${s.creator_id}|${s.platform}|${s.snapshot_date}`, s.cumulative_views ?? 0);
    combos.add(`${s.creator_id}|${s.platform}`);
  }

  const comboList = Array.from(combos);

  const chartData = dates.map(date => {
    const pd = prevDay(date);
    let totalViews = 0;
    for (const combo of comboList) {
      const curr = snapMap.get(`${combo}|${date}`);
      const prev = snapMap.get(`${combo}|${pd}`);
      if (curr !== undefined && prev !== undefined) {
        totalViews += Math.max(0, curr - prev);
      }
    }
    return { name: dateLabel(date), Views: totalViews };
  });

  return NextResponse.json(chartData);
}

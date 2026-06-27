import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import {
  requireAuth,
  allowedCreatorIds,
  scopeToCreators,
  isAuthError,
} from "@/lib/auth";

export async function GET(req: Request) {
  try {
  const ctx = await requireAuth(req);
  const db = createServerClient();
  const ids = await allowedCreatorIds(db, ctx);

  const creatorsQ = db.from("creators").select("*").order("name");

  const [
    { data: creators, error },
    { data: metrics },
    { data: payouts },
    { data: cycles },
    { data: snapshots },
    { data: postRows },
  ] = await Promise.all([
    ids === null ? creatorsQ : creatorsQ.in("id", ids),
    scopeToCreators(db.from("monthly_metrics").select("*").order("year", { ascending: false }).order("month", { ascending: false }), ids),
    scopeToCreators(db.from("payout_cycles").select("creator_id, payout_amount, views_earned, status"), ids),
    scopeToCreators(db.from("creator_cycles").select("creator_id, baseline_views, baseline_capped_views"), ids),
    scopeToCreators(db.from("view_snapshots").select("creator_id, platform, snapshot_date, cumulative_views, capped_cumulative_views").order("snapshot_date", { ascending: false }), ids),
    scopeToCreators(db.from("post_snapshots").select("creator_id"), ids),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const metricsByCreator = new Map<string, typeof metrics>();
  for (const m of metrics ?? []) {
    if (!metricsByCreator.has(m.creator_id)) metricsByCreator.set(m.creator_id, []);
    metricsByCreator.get(m.creator_id)!.push(m);
  }

  // Sum ALL stamped cycle payouts per creator (paid + pending) — every finished
  // cycle counts toward lifetime totals, whether or not it's been paid out yet.
  const payoutsByCreator = new Map<string, { completed_payout_total: number; completed_views_total: number }>();
  for (const p of payouts ?? []) {
    const existing = payoutsByCreator.get(p.creator_id) ?? { completed_payout_total: 0, completed_views_total: 0 };
    existing.completed_payout_total += p.payout_amount ?? 0;
    existing.completed_views_total  += p.views_earned  ?? 0;
    payoutsByCreator.set(p.creator_id, existing);
  }

  // Baseline views per creator from their active cycle — true (display) + capped (payout)
  const baselineByCreator = new Map<string, number>();
  const cappedBaselineByCreator = new Map<string, number>();
  for (const c of cycles ?? []) {
    baselineByCreator.set(c.creator_id, c.baseline_views ?? 0);
    cappedBaselineByCreator.set(c.creator_id, c.baseline_capped_views ?? 0);
  }

  // Latest views per creator+platform (snapshots already ordered desc by date)
  const latestSnapByKey = new Map<string, number>();
  const latestCappedByKey = new Map<string, number>();
  for (const s of snapshots ?? []) {
    const key = `${s.creator_id}::${s.platform}`;
    if (!latestSnapByKey.has(key)) latestSnapByKey.set(key, s.cumulative_views ?? 0);
    if (!latestCappedByKey.has(key)) latestCappedByKey.set(key, s.capped_cumulative_views ?? 0);
  }

  // Sum latest views per creator across all platforms (true + capped)
  const latestTotalByCreator = new Map<string, number>();
  latestSnapByKey.forEach((cumViews, key) => {
    const creatorId = key.split("::")[0];
    latestTotalByCreator.set(creatorId, (latestTotalByCreator.get(creatorId) ?? 0) + cumViews);
  });
  const latestCappedTotalByCreator = new Map<string, number>();
  latestCappedByKey.forEach((cumViews, key) => {
    const creatorId = key.split("::")[0];
    latestCappedTotalByCreator.set(creatorId, (latestCappedTotalByCreator.get(creatorId) ?? 0) + cumViews);
  });

  // Count tracked posts per creator from post_snapshots (respects exclusions)
  const postCountByCreator = new Map<string, number>();
  for (const row of postRows ?? []) {
    postCountByCreator.set(row.creator_id, (postCountByCreator.get(row.creator_id) ?? 0) + 1);
  }

  const result = (creators ?? []).map(c => {
    const baseline = baselineByCreator.get(c.id) ?? 0;
    const latestTotal = latestTotalByCreator.get(c.id) ?? 0;
    const cappedBaseline = cappedBaselineByCreator.get(c.id) ?? 0;
    const latestCappedTotal = latestCappedTotalByCreator.get(c.id) ?? 0;
    return {
      ...c,
      metrics: metricsByCreator.get(c.id) ?? [],
      completed_payout_total: payoutsByCreator.get(c.id)?.completed_payout_total ?? 0,
      completed_views_total:  payoutsByCreator.get(c.id)?.completed_views_total  ?? 0,
      // True delta for display; capped delta for the in-progress payout estimate.
      current_cycle_views: Math.max(0, latestTotal - baseline),
      current_cycle_capped_views: Math.max(0, latestCappedTotal - cappedBaseline),
      tracked_post_count: postCountByCreator.get(c.id) ?? 0,
    };
  });
  return NextResponse.json(result);
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireAuth(req);
    const db = createServerClient();
    const body = await req.json();

    // New creators are stamped with the active campaign. A super_admin must pick
    // a specific campaign first (can't create into "all campaigns").
    if (!ctx.campaignId) {
      return NextResponse.json(
        { error: "Select a campaign before adding a creator." },
        { status: 400 }
      );
    }

    const { data, error } = await db
      .from("creators")
      .insert({
        name: body.name,
        instagram_username: body.instagram_username || null,
        tiktok_username: body.tiktok_username || null,
        base_fee: body.base_fee || 0,
        rate_per_thousand_views: body.rate_per_thousand_views || 2.0,
        affiliate_percentage: body.affiliate_percentage || 0,
        monthly_target: body.monthly_target || 30,
        joined_at: body.joined_at || new Date().toISOString().split("T")[0],
        campaign_id: ctx.campaignId,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data, { status: 201 });
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

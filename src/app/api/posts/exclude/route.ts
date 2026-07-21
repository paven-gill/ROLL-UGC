import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAuth, assertCreatorInScope, isAuthError } from "@/lib/auth";
import { PER_VIDEO_VIEW_CAP, applyCycleViewCap } from "@/lib/constants";
import { getCampaignViewCap } from "@/lib/campaign-caps";

export async function POST(req: Request) {
  try {
  const ctx = await requireAuth(req);
  const body = await req.json();
  const { post_id, creator_id, platform } = body as {
    post_id: string;
    creator_id: string;
    platform: string;
  };

  if (!post_id || !creator_id || !platform) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const db = createServerClient();
  await assertCreatorInScope(db, ctx, creator_id);

  // Read view count + taken_at BEFORE deleting — needed to adjust all aggregates
  const { data: postData } = await db
    .from("post_snapshots")
    .select("view_count_used, taken_at")
    .eq("post_id", post_id)
    .eq("creator_id", creator_id)
    .eq("platform", platform)
    .single();

  const viewCount = postData?.view_count_used ?? 0;
  // The post's contribution to the capped (payable) basis is clamped at the cap.
  const cappedViewCount = Math.min(viewCount, PER_VIDEO_VIEW_CAP);
  const takenAtDate = postData?.taken_at ? postData.taken_at.split("T")[0] : null;

  // 1. Mark as excluded (idempotent)
  const { error: exError } = await db.from("excluded_posts").upsert(
    { post_id, creator_id, platform },
    { onConflict: "post_id,creator_id,platform" }
  );
  if (exError) return NextResponse.json({ error: exError.message }, { status: 500 });

  // 2. Remove from post_snapshots
  const { error: delError } = await db
    .from("post_snapshots")
    .delete()
    .eq("post_id", post_id)
    .eq("creator_id", creator_id)
    .eq("platform", platform);
  if (delError) return NextResponse.json({ error: delError.message }, { status: 500 });

  // Nothing else to adjust if we have no view/date data
  if (!viewCount || !takenAtDate) return NextResponse.json({ ok: true });

  // 3. Fetch creator rate + active cycle in parallel
  const [creatorRes, activeCycleRes, snapsRes] = await Promise.all([
    db.from("creators").select("rate_per_thousand_views, campaign_id").eq("id", creator_id).single(),
    db.from("creator_cycles").select("cycle_start_date, baseline_views, baseline_capped_views").eq("creator_id", creator_id).single(),
    db.from("view_snapshots")
      .select("snapshot_date, cumulative_views, capped_cumulative_views")
      .eq("creator_id", creator_id)
      .eq("platform", platform)
      .gte("snapshot_date", takenAtDate),
  ]);

  const rate = creatorRes.data?.rate_per_thousand_views ?? 2;
  const viewCap = await getCampaignViewCap(db, creatorRes.data?.campaign_id ?? null);
  const activeCycle = activeCycleRes.data;

  // 4. Subtract view count from all daily snapshots on/after taken_at — the true
  //    total drops by the full count; the capped (payable) total by the clamped
  //    contribution.
  await Promise.all(
    (snapsRes.data ?? []).map(snap =>
      db.from("view_snapshots")
        .update({
          cumulative_views: Math.max(0, snap.cumulative_views - viewCount),
          capped_cumulative_views: Math.max(0, (snap.capped_cumulative_views ?? 0) - cappedViewCount),
        })
        .eq("creator_id", creator_id)
        .eq("platform", platform)
        .eq("snapshot_date", snap.snapshot_date)
    )
  );

  // 5. Update monthly_metrics for the post's month
  const postDate = new Date(takenAtDate + "T00:00:00Z");
  const year = postDate.getUTCFullYear();
  const month = postDate.getUTCMonth() + 1;

  const { data: metric } = await db
    .from("monthly_metrics")
    .select("total_views, post_count")
    .eq("creator_id", creator_id)
    .eq("platform", platform)
    .eq("year", year)
    .eq("month", month)
    .single();

  if (metric) {
    await db.from("monthly_metrics")
      .update({
        total_views: Math.max(0, metric.total_views - viewCount),
        post_count: Math.max(0, metric.post_count - 1),
      })
      .eq("creator_id", creator_id)
      .eq("platform", platform)
      .eq("year", year)
      .eq("month", month);
  }

  // 6. Adjust active cycle baseline if post predates the current cycle start
  //    (post was already baked into the baseline, so reduce it)
  if (activeCycle && activeCycle.cycle_start_date > takenAtDate) {
    await db.from("creator_cycles")
      .update({
        baseline_views: Math.max(0, activeCycle.baseline_views - viewCount),
        baseline_capped_views: Math.max(0, (activeCycle.baseline_capped_views ?? 0) - cappedViewCount),
      })
      .eq("creator_id", creator_id);
  }

  // 7. Recalculate any completed payout cycle that covers this post's date. The
  //    true set (end_views / views_earned) drops by the full count for display;
  //    the capped set (end_capped_views / capped_views_earned) by the clamped
  //    amount, and the payout is recomputed from the capped set.
  const { data: affectedCycles } = await db
    .from("payout_cycles")
    .select("id, start_views, end_views, views_earned, capped_views_earned, base_fee")
    .eq("creator_id", creator_id)
    .lte("cycle_start_date", takenAtDate)
    .gte("cycle_end_date", takenAtDate);

  await Promise.all(
    (affectedCycles ?? []).map(cycle => {
      const newEndViews = Math.max(0, cycle.end_views - viewCount);
      const newViewsEarned = Math.max(0, (cycle.views_earned ?? 0) - viewCount);
      // Reducing the earned delta by the clamped contribution is equivalent to
      // recomputing (end_capped − start_capped) with end_capped lowered.
      const newCappedEarned = Math.max(0, (cycle.capped_views_earned ?? 0) - cappedViewCount);
      // Re-apply the campaign payout ceiling: if the (still true) capped total is
      // above the cap, excluding a post below that surplus leaves the payout at the
      // cap. capped_views_earned itself stays the true combined total.
      const newViewBonus = parseFloat(((applyCycleViewCap(newCappedEarned, viewCap) / 1000) * rate).toFixed(2));
      const newPayout = parseFloat((cycle.base_fee + newViewBonus).toFixed(2));
      return db.from("payout_cycles").update({
        end_views: newEndViews,
        views_earned: newViewsEarned,
        capped_views_earned: newCappedEarned,
        view_bonus: newViewBonus,
        payout_amount: newPayout,
      }).eq("id", cycle.id);
    })
  );

  return NextResponse.json({ ok: true });
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

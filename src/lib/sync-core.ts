import { createServerClient } from "@/lib/supabase";
import { type ScrapedData } from "@/lib/apify";
import { uploadTopTikTokThumbs } from "@/lib/thumbnail-storage";
import { businessDate } from "@/lib/date";
import { PER_VIDEO_VIEW_CAP } from "@/lib/constants";

// ─── Where self-calls (cron fan-out + catch-up) should point ─────────────────
// MUST be the STABLE production domain, never the per-deployment VERCEL_URL —
// that one sits behind Vercel Deployment Protection and bounces self-calls with
// a 401 before they reach the function. SYNC_BASE_URL overrides everything
// (local dev / custom domain); VERCEL_PROJECT_PRODUCTION_URL is the stable prod
// domain; VERCEL_URL is a last-resort fallback. Returns null if none are set.
export function resolveSyncBaseUrl(): string | null {
  return (
    process.env.SYNC_BASE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : null) ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
  );
}

// ─── Store one platform's daily snapshot ─────────────────────────────────────
// Shared by the per-creator sync route (manual + Instagram) and the batched
// TikTok endpoint. Self-contained: takes a creator id, platform, and the
// already-scraped data, and writes the daily snapshot + monthly metrics + posts.

export async function storeSnapshot(
  db: ReturnType<typeof createServerClient>,
  creatorId: string,
  platform: "instagram" | "tiktok",
  data: ScrapedData
) {
  const nowTs = new Date();
  // Date the snapshot by the Australian calendar day, not UTC — see lib/date.ts.
  const today = businessDate(nowTs);
  const now = nowTs.toISOString();
  const [currentYear, currentMonth] = today.split("-").map(Number);

  // Compute adjusted cumulative_views by subtracting views of excluded posts
  const { data: excludedForViews } = await db
    .from("excluded_posts")
    .select("post_id")
    .eq("creator_id", creatorId)
    .eq("platform", platform);

  const excludedIdsForViews = new Set((excludedForViews ?? []).map((e: { post_id: string }) => e.post_id));
  const excludedViewsSum = data.posts
    .filter(p => excludedIdsForViews.has(p.post_id))
    .reduce((s, p) => s + p.view_count_used, 0);
  const adjustedCumulativeViews = Math.max(0, data.cumulative_views - excludedViewsSum);

  // Capped (payable) cumulative: each video contributes at most PER_VIDEO_VIEW_CAP.
  // cumulative_views above is exactly sum(view_count_used), so the capped total is
  // the same sum with each post clamped. Equals the true total until a video
  // crosses the cap; only then does the payable basis fall below the display total.
  const cappedCumulativeViews = data.posts
    .filter(p => !excludedIdsForViews.has(p.post_id))
    .reduce((s, p) => s + Math.min(p.view_count_used, PER_VIDEO_VIEW_CAP), 0);

  await db.from("view_snapshots").upsert(
    {
      creator_id: creatorId,
      platform,
      snapshot_date: today,
      cumulative_views: adjustedCumulativeViews,
      capped_cumulative_views: cappedCumulativeViews,
      post_count_30d: data.posts_last_30_days,
      follower_count: data.follower_count,
      synced_at: now,
    },
    { onConflict: "creator_id,platform,snapshot_date" }
  );

  // Analytics cache — calendar-month delta for the monthly_metrics table
  const firstOfMonth = `${currentYear}-${String(currentMonth).padStart(2, "0")}-01`;
  const { data: prevSnap } = await db
    .from("view_snapshots")
    .select("cumulative_views")
    .eq("creator_id", creatorId)
    .eq("platform", platform)
    .lt("snapshot_date", firstOfMonth)
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .single();

  const monthly_views = prevSnap
    ? Math.max(0, data.cumulative_views - prevSnap.cumulative_views)
    : 0;

  await db.from("monthly_metrics").upsert(
    {
      creator_id: creatorId,
      platform,
      year: currentYear,
      month: currentMonth,
      total_views: monthly_views,
      post_count: data.posts_last_30_days,
      follower_count: data.follower_count,
      synced_at: now,
    },
    { onConflict: "creator_id,platform,year,month" }
  );

  if (data.posts.length > 0) {
    // Filter out any posts the user has manually excluded
    const { data: excluded } = await db
      .from("excluded_posts")
      .select("post_id")
      .eq("creator_id", creatorId)
      .eq("platform", platform);

    const excludedIds = new Set((excluded ?? []).map((e: { post_id: string }) => e.post_id));
    const filteredPosts = excludedIds.size > 0
      ? data.posts.filter(p => !excludedIds.has(p.post_id))
      : data.posts;

    const { error: delError } = await db
      .from("post_snapshots")
      .delete()
      .eq("creator_id", creatorId)
      .eq("platform", platform);
    if (delError) console.error("[sync] post_snapshots delete error:", delError);

    if (filteredPosts.length > 0) {
      const rows = filteredPosts.map(({ raw_fields: _raw, ...p }) => ({
        ...p,
        creator_id: creatorId,
        synced_at: now,
      }));
      const { error: insertError } = await db.from("post_snapshots").insert(rows);
      if (insertError) console.error("[sync] post_snapshots insert error:", insertError);
      else console.log(`[sync] inserted ${rows.length} post_snapshots (${excludedIds.size} excluded)`);

      if (platform === "tiktok") {
        await uploadTopTikTokThumbs(db, creatorId, filteredPosts);
      }
    } else {
      console.log(`[sync] all ${data.posts.length} posts excluded, skipping insert`);
    }
  }
}

// ─── Cycle rollover — runs after every sync ───────────────────────────────────
// Keeps each creator's cycle current automatically:
//   • No cycle yet        → onboard: create the first cycle.
//   • Cycle still running  → just report progress, change nothing.
//   • Cycle term is over   → STAMP the finished month as a pending payout
//                            (base retainer + views × CPM up to that point) and
//                            immediately open the next cycle from a fresh baseline.
// Manual control is preserved: editing a payout's dates re-activates that cycle
// (see PATCH /api/payout-cycles/[id]); an already-paid stamp is never overwritten.

export async function processCycle(
  db: ReturnType<typeof createServerClient>,
  creator: {
    id: string;
    joined_at: string | null;
    base_fee: number;
    rate_per_thousand_views: number;
    active?: boolean;
    status?: "active" | "paused" | "finished" | null;
  }
) {
  // Paused / finished creators aren't working with us anymore — never onboard a
  // first cycle, stamp a payout, or roll into a new one. Their existing cycle is
  // left frozen as-is. (The nightly cron already filters to active creators, but
  // the manual "Sync now" button doesn't, so guard here too.)
  const isInactive = creator.active === false ||
    creator.status === "paused" || creator.status === "finished";
  if (isInactive) {
    console.log(`[cycle] ${creator.id}: skipped (creator inactive)`);
    return { action: "skipped_inactive" };
  }

  const today = businessDate();

  // Current total eligible views = latest daily snapshot per platform, summed.
  // We track both the TRUE total (cumulative_views, for display/back-compat) and
  // the CAPPED total (capped_cumulative_views, the payable basis). Payouts use
  // capped; baselines store both so each cycle's earned delta is computed on the
  // capped series. The two are equal until a video crosses PER_VIDEO_VIEW_CAP.
  const { data: snaps } = await db
    .from("view_snapshots")
    .select("platform, cumulative_views, capped_cumulative_views, snapshot_date")
    .eq("creator_id", creator.id)
    .order("snapshot_date", { ascending: false });

  const byPlatform = new Map<string, number>();
  const cappedByPlatform = new Map<string, number>();
  for (const s of snaps ?? []) {
    if (!byPlatform.has(s.platform)) byPlatform.set(s.platform, s.cumulative_views ?? 0);
    if (!cappedByPlatform.has(s.platform)) cappedByPlatform.set(s.platform, s.capped_cumulative_views ?? 0);
  }
  const totalViews = Array.from(byPlatform.values()).reduce((a, b) => a + b, 0);
  const cappedTotalViews = Array.from(cappedByPlatform.values()).reduce((a, b) => a + b, 0);

  const { data: cycle } = await db
    .from("creator_cycles")
    .select("*")
    .eq("creator_id", creator.id)
    .single();

  if (!cycle) {
    // Onboarding — create the very first cycle.
    const cycleStart = creator.joined_at ?? today;
    const cycleEndDate = new Date(cycleStart + "T00:00:00Z");
    cycleEndDate.setDate(cycleEndDate.getDate() + 30);
    const cycleEnd = cycleEndDate.toISOString().split("T")[0];

    const { error: insertError } = await db.from("creator_cycles").insert({
      creator_id: creator.id,
      cycle_start_date: cycleStart,
      cycle_end_date: cycleEnd,
      baseline_views: totalViews,
      baseline_capped_views: cappedTotalViews,
    });

    if (insertError) {
      console.error(`[cycle] INSERT creator_cycles failed:`, insertError);
      throw new Error(`creator_cycles insert failed: ${insertError.message}`);
    }
    console.log(`[cycle] onboarded ${creator.id}: baseline=${totalViews}, ${cycleStart} → ${cycleEnd}`);
    return { action: "onboarded", baseline_views: totalViews, cycle_start: cycleStart, cycle_end: cycleEnd };
  }

  // Cycle still within its term — report progress, change nothing.
  // Progress is the payable (capped) delta, matching how the payout is computed.
  if (today < cycle.cycle_end_date) {
    const views_so_far = Math.max(0, cappedTotalViews - (cycle.baseline_capped_views ?? 0));
    console.log(`[cycle] ${creator.id}: in_progress, views_so_far=${views_so_far}`);
    return { action: "in_progress", views_so_far };
  }

  // ─── Term is over → stamp the finished cycle and roll into the next one ───
  // Pin the closing total to the cumulative views AS OF the cycle's end date —
  // not the latest snapshot, which could be days newer if this runs late (or as
  // a catch-up). Using the boundary keeps post-end-date views in the NEXT cycle.
  const boundaryByPlatform = new Map<string, number>();
  const cappedBoundaryByPlatform = new Map<string, number>();
  for (const s of snaps ?? []) {
    if (s.snapshot_date <= cycle.cycle_end_date) {
      if (!boundaryByPlatform.has(s.platform)) boundaryByPlatform.set(s.platform, s.cumulative_views ?? 0);
      if (!cappedBoundaryByPlatform.has(s.platform)) cappedBoundaryByPlatform.set(s.platform, s.capped_cumulative_views ?? 0);
    }
  }
  const endViews = Array.from(boundaryByPlatform.values()).reduce((a, b) => a + b, 0);
  const cappedEndViews = Array.from(cappedBoundaryByPlatform.values()).reduce((a, b) => a + b, 0);
  // Track both the TRUE earned delta (stored for display) and the CAPPED delta
  // (the payable basis the payout is computed from). Equal until a video crosses
  // PER_VIDEO_VIEW_CAP; after that the payout caps while the display stays true.
  const viewsEarned = Math.max(0, endViews - (cycle.baseline_views ?? 0));
  const cappedViewsEarned = Math.max(0, cappedEndViews - (cycle.baseline_capped_views ?? 0));
  const viewBonus = parseFloat(((cappedViewsEarned / 1000) * creator.rate_per_thousand_views).toFixed(2));
  const baseFee = creator.base_fee ?? 0;
  const payoutAmount = parseFloat((baseFee + viewBonus).toFixed(2));

  // Don't overwrite a payout that's already been paid out — only create/refresh
  // a pending stamp for the cycle that just ended.
  const { data: existingPayout } = await db
    .from("payout_cycles")
    .select("status")
    .eq("creator_id", creator.id)
    .eq("cycle_start_date", cycle.cycle_start_date)
    .maybeSingle();

  if (existingPayout?.status !== "paid") {
    const { error: stampErr } = await db.from("payout_cycles").upsert(
      {
        creator_id: creator.id,
        cycle_start_date: cycle.cycle_start_date,
        cycle_end_date: cycle.cycle_end_date,
        start_views: cycle.baseline_views ?? 0,
        end_views: endViews,
        views_earned: viewsEarned,
        capped_views_earned: cappedViewsEarned,
        base_fee: baseFee,
        view_bonus: viewBonus,
        payout_amount: payoutAmount,
        status: "pending",
      },
      { onConflict: "creator_id,cycle_start_date" }
    );
    if (stampErr) {
      console.error(`[cycle] STAMP payout_cycles failed:`, stampErr);
      throw new Error(`payout_cycles stamp failed: ${stampErr.message}`);
    }
  }

  // Open the next cycle, contiguous with the one that just ended.
  const nextStart = cycle.cycle_end_date;
  const nextEndDate = new Date(nextStart + "T00:00:00Z");
  nextEndDate.setDate(nextEndDate.getDate() + 30);
  const nextEnd = nextEndDate.toISOString().split("T")[0];

  const { error: rollErr } = await db.from("creator_cycles").update({
    cycle_start_date: nextStart,
    cycle_end_date: nextEnd,
    baseline_views: endViews,
    baseline_capped_views: cappedEndViews,
    updated_at: new Date().toISOString(),
  }).eq("creator_id", creator.id);

  if (rollErr) {
    console.error(`[cycle] ROLL creator_cycles failed:`, rollErr);
    throw new Error(`creator_cycles roll failed: ${rollErr.message}`);
  }

  console.log(`[cycle] rolled ${creator.id}: stamped ${cycle.cycle_start_date}→${cycle.cycle_end_date} ($${payoutAmount}, ${viewsEarned} views / ${cappedViewsEarned} payable), new cycle ${nextStart}→${nextEnd} baseline=${endViews} cappedBaseline=${cappedEndViews}`);
  return {
    action: "rolled_over",
    stamped: {
      cycle_start: cycle.cycle_start_date,
      cycle_end: cycle.cycle_end_date,
      views_earned: viewsEarned,
      payout_amount: payoutAmount,
    },
    new_cycle: { cycle_start: nextStart, cycle_end: nextEnd, baseline_views: endViews },
  };
}

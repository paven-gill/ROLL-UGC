import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { scrapeInstagram, scrapeTikTok, type ScrapedData } from "@/lib/apify";
import { uploadTopTikTokThumbs } from "@/lib/thumbnail-storage";

export const maxDuration = 300;

// ─── Store one platform's daily snapshot ─────────────────────────────────────

async function storeSnapshot(
  db: ReturnType<typeof createServerClient>,
  creatorId: string,
  platform: "instagram" | "tiktok",
  data: ScrapedData
) {
  const nowTs = new Date();
  const today = nowTs.toISOString().split("T")[0];
  const now = nowTs.toISOString();
  const currentYear = nowTs.getUTCFullYear();
  const currentMonth = nowTs.getUTCMonth() + 1;

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

  await db.from("view_snapshots").upsert(
    {
      creator_id: creatorId,
      platform,
      snapshot_date: today,
      cumulative_views: adjustedCumulativeViews,
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

// ─── Check and update the rolling cycle ──────────────────────────────────────
// Closes the cycle when the creator hits their post target OR the end date passes.
// Called after ALL platforms are synced so the total reflects both IG + TikTok.

async function checkAndUpdateCycle(
  db: ReturnType<typeof createServerClient>,
  creator: { id: string; joined_at: string | null; base_fee: number; rate_per_thousand_views: number; monthly_target?: number }
) {
  const today = new Date().toISOString().split("T")[0];
  const now = new Date().toISOString();
  const monthly_target = creator.monthly_target ?? 30;

  const { data: todaySnaps } = await db
    .from("view_snapshots")
    .select("cumulative_views")
    .eq("creator_id", creator.id)
    .eq("snapshot_date", today);

  const totalViews = (todaySnaps ?? []).reduce((s, r) => s + (r.cumulative_views ?? 0), 0);

  const { data: cycle } = await db
    .from("creator_cycles")
    .select("*")
    .eq("creator_id", creator.id)
    .single();

  if (!cycle) {
    // ONBOARDING: first sync — set baseline and start the first cycle.
    const cycleStart = creator.joined_at ?? today;
    const cycleEndDate = new Date(cycleStart + "T00:00:00Z");
    cycleEndDate.setDate(cycleEndDate.getDate() + 30);
    const cycleEnd = cycleEndDate.toISOString().split("T")[0];

    const { error: insertError } = await db.from("creator_cycles").insert({
      creator_id: creator.id,
      cycle_start_date: cycleStart,
      cycle_end_date: cycleEnd,
      baseline_views: totalViews,
    });

    if (insertError) {
      console.error(`[cycle] INSERT creator_cycles failed:`, insertError);
      throw new Error(`creator_cycles insert failed: ${insertError.message}`);
    }
    console.log(`[cycle] onboarded ${creator.id}: baseline=${totalViews}, ${cycleStart} → ${cycleEnd}`);
    return { action: "onboarded", baseline_views: totalViews, cycle_start: cycleStart, cycle_end: cycleEnd };
  }

  // Count posts in the current cycle window to check if target is hit
  const { data: cyclePosts } = await db
    .from("post_snapshots")
    .select("taken_at")
    .eq("creator_id", creator.id)
    .gte("taken_at", cycle.cycle_start_date)
    .lte("taken_at", today)
    .order("taken_at", { ascending: true });

  const cyclePostCount = (cyclePosts ?? []).length;
  const targetHit = monthly_target > 0 && cyclePostCount >= monthly_target;
  const dateExpired = today >= cycle.cycle_end_date;

  if (targetHit || dateExpired) {
    // Determine effective end date: use date of the target post if hit early
    let effectiveEndDate: string;
    if (targetHit) {
      const targetPost = (cyclePosts ?? [])[monthly_target - 1];
      effectiveEndDate = targetPost?.taken_at?.split("T")[0] ?? today;
      if (effectiveEndDate > cycle.cycle_end_date) effectiveEndDate = cycle.cycle_end_date;
    } else {
      effectiveEndDate = cycle.cycle_end_date;
    }

    const views_earned = Math.max(0, totalViews - cycle.baseline_views);
    const view_bonus = parseFloat(((views_earned / 1000) * creator.rate_per_thousand_views).toFixed(2));
    const payout_amount = parseFloat((creator.base_fee + view_bonus).toFixed(2));

    await db.from("payout_cycles").upsert(
      {
        creator_id: creator.id,
        cycle_start_date: cycle.cycle_start_date,
        cycle_end_date: effectiveEndDate,
        start_views: cycle.baseline_views,
        end_views: totalViews,
        views_earned,
        base_fee: creator.base_fee,
        view_bonus,
        payout_amount,
        status: "pending",
      },
      { onConflict: "creator_id,cycle_start_date" }
    );

    // Next cycle starts where this one ended
    const nextEndDate = new Date(effectiveEndDate + "T00:00:00Z");
    nextEndDate.setDate(nextEndDate.getDate() + 30);

    await db.from("creator_cycles").update({
      cycle_start_date: effectiveEndDate,
      cycle_end_date: nextEndDate.toISOString().split("T")[0],
      baseline_views: totalViews,
      updated_at: now,
    }).eq("creator_id", creator.id);

    const reason = targetHit ? "target_hit" : "date_expired";
    console.log(`[cycle] closed ${creator.id}: earned=${views_earned}, payout=$${payout_amount}, reason=${reason}`);
    return { action: "cycle_closed", views_earned, payout_amount, reason };
  }

  const views_so_far = Math.max(0, totalViews - cycle.baseline_views);
  const days_remaining = Math.ceil(
    (new Date(cycle.cycle_end_date).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24)
  );
  return { action: "in_progress", views_so_far, days_remaining, post_count: cyclePostCount };
}

// ─── POST /api/sync/[id] ──────────────────────────────────────────────────────

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const db = createServerClient();

  const { data: creator, error } = await db
    .from("creators")
    .select("*")
    .eq("id", params.id)
    .single();

  if (error) return NextResponse.json({ error: "Creator not found" }, { status: 404 });

  console.log(`[sync] Starting sync for: ${creator.name}`);
  const result: Record<string, unknown> = { name: creator.name };

  // Sync each platform (store daily snapshots + post data)
  if (creator.instagram_username) {
    try {
      const data = await scrapeInstagram(creator.instagram_username, creator.joined_at);
      await storeSnapshot(db, creator.id, "instagram", data);
      result.instagram = { cumulative_views: data.cumulative_views };
    } catch (e) {
      console.error("[sync] Instagram error:", e);
      result.instagram_error = String(e);
    }
  }

  if (creator.tiktok_username) {
    try {
      const data = await scrapeTikTok(creator.tiktok_username, creator.joined_at);
      await storeSnapshot(db, creator.id, "tiktok", data);
      result.tiktok = { cumulative_views: data.cumulative_views };
    } catch (e) {
      console.error("[sync] TikTok error:", e);
      result.tiktok_error = String(e);
    }
  }

  // After ALL platforms are synced: check/update the rolling 30-day cycle.
  // This uses the combined total across all platforms from today's snapshots.
  try {
    result.cycle = await checkAndUpdateCycle(db, creator);
  } catch (e) {
    console.error("[sync] Cycle update error:", e);
    result.cycle_error = String(e);
  }

  console.log("[sync] Done:", result);
  return NextResponse.json({ ...result, synced_at: new Date().toISOString() });
}

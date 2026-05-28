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

// ─── Read cycle status only — sync never modifies creator_cycles ──────────────
// The only exception is onboarding: if no cycle exists yet, create the first one.
// All cycle transitions (rollovers, date changes) are managed manually via the UI.

async function checkCycleStatus(
  db: ReturnType<typeof createServerClient>,
  creator: { id: string; joined_at: string | null; base_fee: number; rate_per_thousand_views: number }
) {
  const today = new Date().toISOString().split("T")[0];

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
    // Onboarding only — create the very first cycle and never touch it again via sync.
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

  const views_so_far = Math.max(0, totalViews - cycle.baseline_views);
  const dateExpired = today >= cycle.cycle_end_date;
  console.log(`[cycle] ${creator.id}: views_so_far=${views_so_far}, expired=${dateExpired}`);
  return { action: dateExpired ? "expired" : "in_progress", views_so_far };
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

  // After ALL platforms are synced: check cycle status (read-only — never modifies cycles).
  try {
    result.cycle = await checkCycleStatus(db, creator);
  } catch (e) {
    console.error("[sync] Cycle status error:", e);
    result.cycle_error = String(e);
  }

  console.log("[sync] Done:", result);
  return NextResponse.json({ ...result, synced_at: new Date().toISOString() });
}

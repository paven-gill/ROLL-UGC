import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { scrapeInstagram, scrapeTikTok, type ScrapedData } from "@/lib/apify";
import { uploadTopTikTokThumbs, cleanupTikTokThumbs } from "@/lib/thumbnail-storage";

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

  // Fetch excluded posts once and reuse for both view adjustment and post filtering
  const { data: excluded } = await db
    .from("excluded_posts")
    .select("post_id")
    .eq("creator_id", creatorId)
    .eq("platform", platform);

  const excludedIds = new Set((excluded ?? []).map((e: { post_id: string }) => e.post_id));

  const excludedViewsSum = data.posts
    .filter(p => excludedIds.has(p.post_id))
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

  // Analytics cache — calendar-month delta (not used for payouts)
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
    const filteredPosts = excludedIds.size > 0
      ? data.posts.filter(p => !excludedIds.has(p.post_id))
      : data.posts;

    await db
      .from("post_snapshots")
      .delete()
      .eq("creator_id", creatorId)
      .eq("platform", platform);

    if (filteredPosts.length > 0) {
      await db.from("post_snapshots").insert(
        filteredPosts.map(p => ({ ...p, creator_id: creatorId, synced_at: now }))
      );

      if (platform === "tiktok") {
        await uploadTopTikTokThumbs(db, creatorId, filteredPosts);
      }
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

    await db.from("creator_cycles").insert({
      creator_id: creator.id,
      cycle_start_date: cycleStart,
      cycle_end_date: cycleEnd,
      baseline_views: totalViews,
    });

    return { action: "onboarded", baseline_views: totalViews };
  }

  const views_so_far = Math.max(0, totalViews - cycle.baseline_views);
  const dateExpired = today >= cycle.cycle_end_date;
  return { action: dateExpired ? "expired" : "in_progress", views_so_far };
}

// ─── Sync one creator (both platforms in parallel) ───────────────────────────

async function syncCreator(
  db: ReturnType<typeof createServerClient>,
  creator: { id: string; name: string; instagram_username?: string | null; tiktok_username?: string | null; joined_at: string | null; base_fee: number; rate_per_thousand_views: number }
) {
  const result: Record<string, unknown> = { name: creator.name };

  const [igResult, ttResult] = await Promise.allSettled([
    creator.instagram_username
      ? scrapeInstagram(creator.instagram_username, creator.joined_at)
          .then(async data => { await storeSnapshot(db, creator.id, "instagram", data); return data; })
      : Promise.resolve(null),
    creator.tiktok_username
      ? scrapeTikTok(creator.tiktok_username, creator.joined_at)
          .then(async data => { await storeSnapshot(db, creator.id, "tiktok", data); return data; })
      : Promise.resolve(null),
  ]);

  if (igResult.status === "fulfilled" && igResult.value) {
    result.instagram = { cumulative_views: igResult.value.cumulative_views };
  } else if (igResult.status === "rejected") {
    result.instagram_error = String(igResult.reason);
  }

  if (ttResult.status === "fulfilled" && ttResult.value) {
    result.tiktok = { cumulative_views: ttResult.value.cumulative_views };
  } else if (ttResult.status === "rejected") {
    result.tiktok_error = String(ttResult.reason);
  }

  try {
    result.cycle = await checkCycleStatus(db, creator);
  } catch (e) { result.cycle_error = String(e); }

  return result;
}

// ─── GET /api/sync (daily cron at 11:55pm UTC) ────────────────────────────────

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createServerClient();
  const { data: creators, error } = await db
    .from("creators")
    .select("*")
    .eq("active", true);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results: Awaited<ReturnType<typeof syncCreator>>[] = [];
  for (const creator of creators ?? []) {
    results.push(await syncCreator(db, creator));
  }

  await cleanupTikTokThumbs(db);

  return NextResponse.json({ results, synced_at: new Date().toISOString() });
}

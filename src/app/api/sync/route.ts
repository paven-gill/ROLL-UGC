import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { scrapeInstagram, scrapeTikTok, type ScrapedData } from "@/lib/apify";

export const maxDuration = 300;

// ─── Store one platform's daily snapshot ─────────────────────────────────────

async function storeSnapshot(
  db: ReturnType<typeof createServerClient>,
  creatorId: string,
  platform: "instagram" | "tiktok",
  data: ScrapedData
) {
  const today = new Date().toISOString().split("T")[0];
  const now = new Date().toISOString();
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  await db.from("view_snapshots").upsert(
    {
      creator_id: creatorId,
      platform,
      snapshot_date: today,
      cumulative_views: data.cumulative_views,
      post_count_30d: data.posts_last_30_days,
      follower_count: data.follower_count,
      synced_at: now,
    },
    { onConflict: "creator_id,platform,snapshot_date" }
  );

  // Analytics cache — calendar-month delta (not used for payouts)
  const firstOfMonth = new Date(currentYear, currentMonth - 1, 1).toISOString().split("T")[0];
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
    await db.from("post_snapshots").upsert(
      data.posts.map(p => ({ ...p, creator_id: creatorId, synced_at: now })),
      { onConflict: "post_id,creator_id,platform" }
    );
  }
}

// ─── Check and update the rolling 30-day cycle ───────────────────────────────

async function checkAndUpdateCycle(
  db: ReturnType<typeof createServerClient>,
  creator: { id: string; joined_at: string | null; base_fee: number; rate_per_thousand_views: number }
) {
  const today = new Date().toISOString().split("T")[0];
  const now = new Date().toISOString();

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
    const cycleStart = creator.joined_at ?? today;
    const cycleEndDate = new Date(cycleStart);
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

  if (today >= cycle.cycle_end_date) {
    const views_earned = Math.max(0, totalViews - cycle.baseline_views);
    const view_bonus = parseFloat(((views_earned / 1000) * creator.rate_per_thousand_views).toFixed(2));
    const payout_amount = parseFloat((creator.base_fee + view_bonus).toFixed(2));

    await db.from("payout_cycles").upsert(
      {
        creator_id: creator.id,
        cycle_start_date: cycle.cycle_start_date,
        cycle_end_date: cycle.cycle_end_date,
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

    const nextEndDate = new Date(cycle.cycle_end_date);
    nextEndDate.setDate(nextEndDate.getDate() + 30);

    await db.from("creator_cycles").update({
      cycle_start_date: cycle.cycle_end_date,
      cycle_end_date: nextEndDate.toISOString().split("T")[0],
      baseline_views: totalViews,
      updated_at: now,
    }).eq("creator_id", creator.id);

    return { action: "cycle_closed", views_earned, payout_amount };
  }

  return { action: "in_progress", views_so_far: Math.max(0, totalViews - cycle.baseline_views) };
}

// ─── GET /api/sync (daily cron at 6am UTC) ────────────────────────────────────

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

  const results = [];
  for (const creator of creators ?? []) {
    const result: Record<string, unknown> = { name: creator.name };

    if (creator.instagram_username) {
      try {
        const data = await scrapeInstagram(creator.instagram_username, creator.joined_at);
        await storeSnapshot(db, creator.id, "instagram", data);
        result.instagram = { cumulative_views: data.cumulative_views };
      } catch (e) { result.instagram_error = String(e); }
    }

    if (creator.tiktok_username) {
      try {
        const data = await scrapeTikTok(creator.tiktok_username, creator.joined_at);
        await storeSnapshot(db, creator.id, "tiktok", data);
        result.tiktok = { cumulative_views: data.cumulative_views };
      } catch (e) { result.tiktok_error = String(e); }
    }

    try {
      result.cycle = await checkAndUpdateCycle(db, creator);
    } catch (e) { result.cycle_error = String(e); }

    results.push(result);
  }

  return NextResponse.json({ results, synced_at: new Date().toISOString() });
}

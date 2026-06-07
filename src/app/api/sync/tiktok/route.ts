import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { scrapeTikTokBatch, type TikTokTarget, type ScrapedData } from "@/lib/apify";
import { storeSnapshot } from "@/lib/sync-core";

export const maxDuration = 300;

// ─── POST /api/sync/tiktok ────────────────────────────────────────────────────
//
// Batched TikTok sync for ALL active creators in ONE Apify run.
//
// Instead of one Apify run per creator (which pays the actor's startup overhead
// N times and is what made the bill scale linearly with creator count), we send
// every creator's profile to a single run, then split the results back out and
// store each creator's snapshot. The cost of the startup overhead is now paid
// once per night, not once per creator — so 50 creators costs roughly the same
// per-run overhead as 1.
//
// Called by the nightly cron (GET /api/sync) before it fans out the per-creator
// Instagram children, so each creator's TikTok snapshot is already committed by
// the time the cycle check runs. The manual "Sync now" button still hits
// /api/sync/[id], which scrapes that one creator's TikTok directly.

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createServerClient();
  const { data: creators, error } = await db
    .from("creators")
    .select("id,name,tiktok_username,joined_at")
    .eq("active", true)
    .not("tiktok_username", "is", null);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const list = (creators ?? []).filter(c => c.tiktok_username);
  if (list.length === 0) {
    return NextResponse.json({ synced: 0, results: [], synced_at: new Date().toISOString() });
  }

  const targets: TikTokTarget[] = list.map(c => ({
    username: c.tiktok_username as string,
    joinedAt: c.joined_at,
  }));

  let byHandle: Map<string, ScrapedData>;
  try {
    byHandle = await scrapeTikTokBatch(targets);
  } catch (e) {
    console.error("[sync/tiktok] batch scrape failed:", e);
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }

  // Store every creator's snapshot concurrently. One creator's store failing
  // must not block the others, so we settle independently.
  const norm = (s: string) => s.trim().replace(/^@/, "").toLowerCase();
  const settled = await Promise.allSettled(
    list.map(async creator => {
      const data = byHandle.get(norm(creator.tiktok_username as string));
      if (!data) return { status: "skip", name: creator.name };
      await storeSnapshot(db, creator.id, "tiktok", data);
      return { status: "ok", name: creator.name, cumulative_views: data.cumulative_views };
    })
  );

  const results = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : { status: "error", name: list[i]?.name, error: String(s.reason) }
  );

  const ok = results.filter(r => r.status === "ok").length;
  console.log(`[sync/tiktok] batched ${list.length} creators: ${ok} stored`);

  return NextResponse.json({
    synced: list.length,
    ok,
    results,
    synced_at: new Date().toISOString(),
  });
}

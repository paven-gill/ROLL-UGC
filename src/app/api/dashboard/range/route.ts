import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const days = Math.min(90, Math.max(1, parseInt(searchParams.get("days") || "30", 10)));

  const db = createServerClient();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split("T")[0];

  const [{ data: creators }, { data: snapshots }] = await Promise.all([
    db.from("creators")
      .select("id, name, instagram_username, tiktok_username, base_fee, rate_per_thousand_views")
      .eq("active", true)
      .order("name"),
    db.from("view_snapshots")
      .select("creator_id, platform, cumulative_views, post_count_30d, snapshot_date")
      .order("snapshot_date", { ascending: false }),
  ]);

  if (!creators) return NextResponse.json({ results: [], windowAccurate: false });

  // windowAccurate = true only if every creator had a snapshot at/before the cutoff date
  let windowAccurate = true;

  const results = creators.map(creator => {
    let ig_views = 0, tt_views = 0, ig_posts = 0, tt_posts = 0;

    for (const platform of ["instagram", "tiktok"] as const) {
      const snaps = (snapshots || []).filter(
        s => s.creator_id === creator.id && s.platform === platform
      );

      const latest = snaps[0];
      if (!latest) continue;

      // Prefer snapshot at/before cutoff; fall back to oldest available so we show
      // something rather than 0 while daily syncing hasn't been running yet.
      const atCutoff = snaps.find(s => s.snapshot_date <= cutoffStr);
      if (!atCutoff) windowAccurate = false;
      const baseline = atCutoff ?? snaps[snaps.length - 1];

      const views = baseline && baseline.snapshot_date !== latest.snapshot_date
        ? Math.max(0, latest.cumulative_views - baseline.cumulative_views)
        : 0;

      if (platform === "instagram") {
        ig_views = views;
        ig_posts = latest.post_count_30d || 0;
      } else {
        tt_views = views;
        tt_posts = latest.post_count_30d || 0;
      }
    }

    const total_views = ig_views + tt_views;
    const total_posts = ig_posts + tt_posts;
    const payout = (total_views / 1000) * creator.rate_per_thousand_views;

    return {
      id: creator.id,
      name: creator.name,
      instagram_username: creator.instagram_username,
      tiktok_username: creator.tiktok_username,
      base_fee: creator.base_fee,
      rate_per_thousand_views: creator.rate_per_thousand_views,
      ig_views, tt_views, total_views,
      ig_posts, tt_posts, total_posts,
      payout,
    };
  });

  return NextResponse.json({ results, windowAccurate });
}

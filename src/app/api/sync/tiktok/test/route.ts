import { NextResponse } from "next/server";
import { scrapeTikTok as scrapeApify } from "@/lib/apify";
import { scrapeTikTokScraptik } from "@/lib/scraptik";

export const maxDuration = 300;

// ─── GET /api/sync/tiktok/test?username=<handle>&compare=1 ─────────────────────
//
// DRY RUN — validation only. Scrapes one creator with ScrapTik and returns the
// parsed snapshot WITHOUT writing anything to the database. Pass &compare=1 to
// also run the legacy Apify scraper for the same handle, so you can eyeball that
// the view counts / follower counts / post counts line up before flipping
// TIKTOK_SCRAPER=scraptik in production.
//
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     "https://<your-app>/api/sync/tiktok/test?username=somehandle&compare=1"

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const username = url.searchParams.get("username");
  const compare = url.searchParams.get("compare") === "1";
  if (!username) {
    return NextResponse.json({ error: "Pass ?username=<tiktok handle>" }, { status: 400 });
  }

  const out: Record<string, unknown> = { username };

  try {
    const s = await scrapeTikTokScraptik(username);
    out.scraptik = {
      cumulative_views: s.cumulative_views,
      posts_last_30_days: s.posts_last_30_days,
      follower_count: s.follower_count,
      post_count: s.posts.length,
      sample_posts: s.posts.slice(0, 3),
    };
  } catch (e) {
    out.scraptik_error = String(e);
  }

  if (compare) {
    try {
      const a = await scrapeApify(username);
      out.apify = {
        cumulative_views: a.cumulative_views,
        posts_last_30_days: a.posts_last_30_days,
        follower_count: a.follower_count,
        post_count: a.posts.length,
      };
    } catch (e) {
      out.apify_error = String(e);
    }
  }

  return NextResponse.json(out);
}

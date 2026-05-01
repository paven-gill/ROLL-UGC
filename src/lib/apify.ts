import { ApifyClient } from "apify-client";

// ─── Instagram via RapidAPI (Instagram Looter2) ───────────────────────────────

const IG_BASE = "https://instagram-looter2.p.rapidapi.com";

function rapidHeaders() {
  return {
    "Content-Type": "application/json",
    "x-rapidapi-host": "instagram-looter2.p.rapidapi.com",
    "x-rapidapi-key": process.env.RAPIDAPI_KEY!,
  };
}

async function igGet(path: string) {
  const res = await fetch(`${IG_BASE}${path}`, { headers: rapidHeaders() });
  if (!res.ok) throw new Error(`RapidAPI ${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

function isWithinDays(ts: number | string, days: number): boolean {
  const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return d >= cutoff;
}

function getViewCount(item: Record<string, unknown>): { views: number; field: string } {
  const checks: Array<[string, unknown]> = [
    ["ig_reels_video_view_total_count", item.ig_reels_video_view_total_count],
    ["ig_play_count", item.ig_play_count],
    ["play_count", item.play_count],
    ["view_count", item.view_count],
    ["video_view_count", item.video_view_count],
  ];
  for (const [field, val] of checks) {
    if (typeof val === "number" && val > 0) return { views: val, field };
  }
  return { views: 0, field: "none" };
}

function getThumbnailUrl(p: Record<string, unknown>): string | null {
  if (typeof p.thumbnail_url === "string" && p.thumbnail_url) return p.thumbnail_url;
  if (typeof p.display_url === "string" && p.display_url) return p.display_url;
  const iv2 = p.image_versions2 as Record<string, unknown> | undefined;
  if (iv2) {
    const candidates = iv2.candidates as Array<Record<string, unknown>> | undefined;
    if (candidates?.[0] && typeof candidates[0].url === "string") return candidates[0].url;
  }
  const carousel = p.carousel_media as Array<Record<string, unknown>> | undefined;
  if (carousel?.[0]) {
    const iv2c = carousel[0].image_versions2 as Record<string, unknown> | undefined;
    const candidates = iv2c?.candidates as Array<Record<string, unknown>> | undefined;
    if (candidates?.[0] && typeof candidates[0].url === "string") return candidates[0].url;
  }
  return null;
}

export interface PostSnapshot {
  post_id: string;
  platform: string;
  media_type: string | null;
  taken_at: string | null;
  view_count_used: number;
  view_field_used: string;
  like_count: number;
  comment_count: number;
  thumbnail_url: string | null;
  raw_fields: Record<string, unknown>;
}

export interface ScrapedData {
  cumulative_views: number;
  posts_last_30_days: number;
  follower_count: number;
  posts: PostSnapshot[];
}

// Fetches feed pages for view count data, stopping on cycling or cutoff
async function fetchFeedForViewCounts(
  endpoint: string,
  stopBeforeTs?: number
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  const seenIds = new Set<string>();
  let cursor: string | null = null;
  let page = 0;
  const MAX_PAGES = 30;

  while (page < MAX_PAGES) {
    page++;
    const url = cursor ? `${endpoint}&cursor=${encodeURIComponent(cursor)}` : endpoint;
    const data = await igGet(url);
    const items: Record<string, unknown>[] = data.items || data.data || [];

    if (items.length === 0) break;

    let newThisPage = 0;
    let dupeCount = 0;
    let oldCount = 0;

    for (const item of items) {
      // Prefer code (shortcode) — pk from /user-feeds is a JS number and loses
      // the last ~3 digits of precision on 64-bit Instagram IDs, so it won't
      // match the string pk returned by /reels.
      const itemId = String(item.code || item.shortcode || item.pk || item.id || "");
      if (itemId && seenIds.has(itemId)) {
        dupeCount++;
        continue;
      }
      if (itemId) seenIds.add(itemId);

      if (stopBeforeTs) {
        const ts = item.taken_at as number | undefined;
        if (ts !== undefined && ts < stopBeforeTs) {
          oldCount++;
          continue;
        }
      }
      all.push(item);
      newThisPage++;
    }

    const nextCursor =
      data.next_max_id ||
      data.page_info?.end_cursor ||
      data.pagination_token ||
      data.next_cursor ||
      null;

    console.log(`[rapidapi] page ${page}: ${items.length} raw, ${newThisPage} new, ${dupeCount} dupes, ${oldCount} old, total: ${all.length}`);

    // API is cycling — full page of already-seen posts
    if (dupeCount === items.length) {
      console.log("[rapidapi] full-page duplicates — API cycling, stopping");
      break;
    }

    if (!nextCursor) break;
    cursor = String(nextCursor);

    // Avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }

  return all;
}

export async function scrapeInstagram(username: string, joinedAt?: string | null): Promise<ScrapedData> {
  // Step 1: get user ID + follower count
  const profile = await igGet(`/profile?username=${username}`);

  const userId = profile.pk || profile.id || profile.user_id;
  const follower_count =
    (profile.edge_followed_by as { count: number })?.count ||
    profile.follower_count ||
    profile.followersCount || 0;

  if (!userId) throw new Error(`Could not find user ID for @${username}`);
  console.log(`[rapidapi] @${username} → userId: ${userId}, followers: ${follower_count}`);

  const stopBeforeTs = joinedAt ? Math.floor(new Date(joinedAt).getTime() / 1000) : undefined;

  // Step 2: paginate /reels to get all reels (API returns 12/page via paging_info.max_id)
  // Items are wrapped: { media: { pk, taken_at, ig_play_count, ... } } — unwrap
  const allReels: Record<string, unknown>[] = [];
  let reelMaxId: string | null = null;
  let reelPage = 0;
  const MAX_REEL_PAGES = 30;
  let hitCutoff = false;

  while (reelPage < MAX_REEL_PAGES && !hitCutoff) {
    reelPage++;
    const url = reelMaxId
      ? `/reels?id=${userId}&max_id=${encodeURIComponent(reelMaxId)}`
      : `/reels?id=${userId}`;
    const reelsResp = await igGet(url);
    const pageItems: Record<string, unknown>[] = (reelsResp.items || reelsResp.data || []).map(
      (item: Record<string, unknown>) => (item.media as Record<string, unknown>) ?? item
    );

    let addedThisPage = 0;
    for (const p of pageItems) {
      if (p.media_type !== undefined && p.media_type !== 2) continue;
      if (stopBeforeTs) {
        const raw = p.taken_at || p.timestamp || p.created_at;
        if (raw) {
          const ts = typeof raw === "string" ? Math.floor(new Date(raw).getTime() / 1000) : (raw as number);
          if (ts < stopBeforeTs) { hitCutoff = true; continue; }
        }
      }
      allReels.push(p);
      addedThisPage++;
    }

    const pi = reelsResp.paging_info as Record<string, unknown> | undefined;
    reelMaxId = pi?.more_available ? String(pi.max_id) : null;
    console.log(`[rapidapi] /reels page ${reelPage}: ${pageItems.length} raw, ${addedThisPage} kept, total: ${allReels.length}${reelMaxId ? "" : " (done)"}`);

    if (!reelMaxId) break;
    await new Promise(r => setTimeout(r, 300));
  }

  const filteredReels = allReels;
  console.log(`[rapidapi] /reels: ${filteredReels.length} reels after cutoff filter`);

  // Step 3: fetch feed pages (with dedup) to get real view counts
  const feedItems = await fetchFeedForViewCounts(
    `/user-feeds?id=${userId}&count=50&allow_restricted_media=false`,
    stopBeforeTs
  );
  const feedReels = feedItems.filter((p: Record<string, unknown>) => p.media_type === 2);
  console.log(`[rapidapi] feed: ${feedItems.length} items, ${feedReels.length} reels with view counts`);

  // Build view-count lookup keyed by shortcode (code field).
  // pk from /user-feeds is a JS number and loses precision on 64-bit IDs;
  // code is always a short ASCII string and is consistent across endpoints.
  const postId = (item: Record<string, unknown>) =>
    String(item.code || item.shortcode || item.pk || item.id || "");

  const feedMap = new Map<string, Record<string, unknown>>();
  for (const item of feedReels) {
    const id = postId(item);
    if (id) feedMap.set(id, item);
  }

  // Step 4: merge — enrich /reels items with feed data where available
  const reelIds = new Set(filteredReels.map(postId));
  const mergedReels: Record<string, unknown>[] = filteredReels.map(reel => {
    const id = postId(reel);
    const feedItem = feedMap.get(id);
    return feedItem ? { ...reel, ...feedItem } : reel;
  });
  // Add any feed reels not already in the /reels list
  for (const feedReel of feedReels) {
    const id = postId(feedReel);
    if (id && !reelIds.has(id)) mergedReels.push(feedReel);
  }
  // Sort newest first
  mergedReels.sort((a, b) => ((b.taken_at as number) || 0) - ((a.taken_at as number) || 0));

  console.log(`[rapidapi] merged reel count: ${mergedReels.length}`);
  if (mergedReels[0]) {
    const r = mergedReels[0];
    console.log(`[rapidapi] first reel view fields: ig_play_count=${r.ig_play_count} play_count=${r.play_count} view_count=${r.view_count} ig_reels_video_view_total_count=${r.ig_reels_video_view_total_count}`);
  }

  let cumulative_views = 0;
  let posts_last_30_days = 0;
  const posts: PostSnapshot[] = [];

  for (const p of mergedReels) {
    const { views, field } = getViewCount(p);
    const takenAtRaw = p.taken_at || p.timestamp || p.created_at;
    const takenAt = takenAtRaw
      ? (typeof takenAtRaw === "number"
          ? new Date((takenAtRaw as number) * 1000).toISOString()
          : String(takenAtRaw))
      : null;

    cumulative_views += views;
    if (takenAtRaw && isWithinDays(takenAtRaw as number | string, 30)) posts_last_30_days++;

    posts.push({
      post_id: String(p.code || p.shortcode || p.pk || p.id || ""),
      platform: "instagram",
      media_type: "reel",
      taken_at: takenAt,
      view_count_used: views,
      view_field_used: field,
      like_count: typeof p.like_count === "number" ? p.like_count : 0,
      comment_count: typeof p.comment_count === "number" ? p.comment_count : 0,
      thumbnail_url: getThumbnailUrl(p),
      raw_fields: {
        ig_reels_video_view_total_count: p.ig_reels_video_view_total_count,
        ig_play_count: p.ig_play_count,
        play_count: p.play_count,
        view_count: p.view_count,
        video_view_count: p.video_view_count,
      },
    });
  }

  console.log(`[rapidapi] @${username} — cumulative views: ${cumulative_views}, posts (30d): ${posts_last_30_days}`);
  return { cumulative_views, posts_last_30_days, follower_count, posts };
}

// ─── TikTok via Apify ─────────────────────────────────────────────────────────

const apifyClient = new ApifyClient({ token: process.env.APIFY_API_TOKEN });

export async function scrapeTikTok(username: string, joinedAt?: string | null): Promise<ScrapedData> {
  const run = await apifyClient.actor("clockworks/free-tiktok-scraper").call(
    {
      profiles: [`https://www.tiktok.com/@${username}`],
      resultsPerPage: 100,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
    },
    { waitSecs: 180 }
  );

  const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
  if (!items.length) return { cumulative_views: 0, posts_last_30_days: 0, follower_count: 0, posts: [] };

  const first = items[0] as Record<string, unknown>;
  const authorMeta = (first.authorMeta as Record<string, unknown>) || {};
  const follower_count = (authorMeta.fans as number) || 0;

  const joinedAtTs = joinedAt ? new Date(joinedAt).getTime() : 0;

  let cumulative_views = 0;
  let posts_last_30_days = 0;
  const posts: PostSnapshot[] = [];

  if (items.length > 0) {
    const sample = items[0] as Record<string, unknown>;
    console.log(`[apify] TikTok sample fields: createTimeISO=${sample.createTimeISO} createTime=${sample.createTime} playCount=${sample.playCount} id=${sample.id}`);
  }

  for (const item of items as Record<string, unknown>[]) {
    // Build a date string — handle missing/invalid timestamps gracefully
    let dateStr: string | null = null;
    if (typeof item.createTimeISO === "string" && item.createTimeISO) {
      dateStr = item.createTimeISO;
    } else if (typeof item.createTime === "number" && item.createTime > 0) {
      const d = new Date(item.createTime * 1000);
      if (!isNaN(d.getTime())) dateStr = d.toISOString();
    }
    if (!dateStr) continue;

    // Skip posts before join date
    if (joinedAtTs && new Date(dateStr).getTime() < joinedAtTs) continue;

    const playCount = (item.playCount as number) || 0;
    const videoMeta = item.videoMeta as Record<string, unknown> | undefined;
    const ttThumb =
      (typeof videoMeta?.coverUrl === "string" ? videoMeta.coverUrl : null) ||
      (Array.isArray(item.covers) && typeof item.covers[0] === "string" ? item.covers[0] : null);

    cumulative_views += playCount;
    if (isWithinDays(dateStr, 30)) posts_last_30_days++;

    posts.push({
      post_id: String(item.id || item.webVideoUrl || ""),
      platform: "tiktok",
      media_type: "video",
      taken_at: dateStr,
      view_count_used: playCount,
      view_field_used: playCount > 0 ? "playCount" : "none",
      like_count: (item.diggCount as number) || 0,
      comment_count: (item.commentCount as number) || 0,
      thumbnail_url: ttThumb,
      raw_fields: { playCount: item.playCount },
    });
  }

  console.log(`[apify] TikTok @${username} — cumulative: ${cumulative_views}, posts (30d): ${posts_last_30_days}, followers: ${follower_count}`);
  return { cumulative_views, posts_last_30_days, follower_count, posts };
}

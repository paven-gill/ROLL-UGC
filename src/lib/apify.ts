// ─── Instagram via RapidAPI (Instagram Looter2) ───────────────────────────────

const IG_BASE = "https://instagram-looter2.p.rapidapi.com";

function rapidHeaders() {
  return {
    "Content-Type": "application/json",
    "x-rapidapi-host": "instagram-looter2.p.rapidapi.com",
    "x-rapidapi-key": process.env.RAPIDAPI_KEY!,
  };
}

// Statuses worth retrying: 429 (rate limit) plus transient upstream 5xx.
// Anything else (e.g. 404 for a deleted handle) is permanent — fail fast so we
// don't burn attempts on a request that will never succeed.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const IG_MAX_ATTEMPTS = 5;

// Back-off schedule with jitter. Honors a Retry-After header when the provider
// sends one; otherwise exponential (0.5s, 1s, 2s, 4s, capped 8s) + a little
// random spread so a fleet of concurrent scrapes doesn't all retry in lockstep.
function igBackoffMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  return Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
}

// Rate-limit-aware GET. A 429 (or transient 5xx / network blip) becomes a short
// wait-and-retry instead of a thrown error — so a creator whose scrape loses the
// race against the provider's per-second limit recovers on its own rather than
// being dropped for the night. Paired with the capped concurrency in the sync
// fan-out (api/sync/route.ts), which keeps 429s rare in the first place.
async function igGet(path: string) {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${IG_BASE}${path}`, { headers: rapidHeaders() });
    } catch (err) {
      // Network-level failure (connection reset, DNS blip) — retry like a 5xx.
      if (attempt < IG_MAX_ATTEMPTS) {
        const ms = igBackoffMs(attempt, null);
        console.warn(`[rapidapi] ${path} → network error; retry ${attempt}/${IG_MAX_ATTEMPTS - 1} in ${ms}ms`);
        await new Promise(r => setTimeout(r, ms));
        continue;
      }
      throw err;
    }

    if (res.ok) return res.json();

    if (RETRYABLE_STATUS.has(res.status) && attempt < IG_MAX_ATTEMPTS) {
      const ms = igBackoffMs(attempt, res.headers.get("retry-after"));
      console.warn(`[rapidapi] ${path} → ${res.status}; retry ${attempt}/${IG_MAX_ATTEMPTS - 1} in ${ms}ms`);
      await new Promise(r => setTimeout(r, ms));
      continue;
    }

    throw new Error(`RapidAPI ${path} → ${res.status} ${res.statusText}`);
  }
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

const TIKTOK_ACTOR = "clockworks~free-tiktok-scraper";

// Start an actor run and poll to completion, returning the dataset items.
// `timeoutMs` scales with how big a batch we asked for (one profile vs many).
async function apifyRunAndCollect(
  input: Record<string, unknown>,
  timeoutMs = 180_000
): Promise<Record<string, unknown>[]> {
  const token = process.env.APIFY_API_TOKEN;
  const runRes = await fetch(
    `https://api.apify.com/v2/acts/${TIKTOK_ACTOR}/runs?token=${token}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }
  );
  if (!runRes.ok) throw new Error(`Apify start run → ${runRes.status} ${runRes.statusText}`);
  const runId = (await runRes.json()).data.id as string;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5_000));
    const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`);
    const statusData = await statusRes.json();
    const { status, defaultDatasetId } = statusData.data as { status: string; defaultDatasetId: string };
    if (status === "SUCCEEDED") {
      const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${defaultDatasetId}/items?token=${token}`);
      return (await itemsRes.json()) as Record<string, unknown>[];
    }
    if (status === "FAILED" || status === "ABORTED" || status === "TIMED-OUT") {
      throw new Error(`Apify actor run ${status}`);
    }
  }
  throw new Error(`Apify actor run timed out after ${Math.round(timeoutMs / 1000)}s`);
}

const normalizeHandle = (s: string) => s.trim().replace(/^@/, "").toLowerCase();

// Which creator a scraped video belongs to. Prefer the author handle in the
// item's metadata; fall back to parsing @handle out of the video URL.
function authorHandle(item: Record<string, unknown>): string | null {
  const meta = item.authorMeta as Record<string, unknown> | undefined;
  const name = (meta?.name as string) || (meta?.uniqueId as string);
  if (typeof name === "string" && name) return name.trim().toLowerCase();
  const url = item.webVideoUrl as string | undefined;
  const m = url?.match(/@([^/]+)\//);
  return m ? m[1].toLowerCase() : null;
}

// Normalize a flat list of scraped video items (already filtered to one author)
// into our snapshot. Shared by the single + batched scrape paths.
function buildTikTokData(items: Record<string, unknown>[], joinedAt?: string | null): ScrapedData {
  if (!items.length) return { cumulative_views: 0, posts_last_30_days: 0, follower_count: 0, posts: [] };

  const authorMeta = (items[0].authorMeta as Record<string, unknown>) || {};
  const follower_count = (authorMeta.fans as number) || 0;
  const joinedAtTs = joinedAt ? new Date(joinedAt).getTime() : 0;

  let cumulative_views = 0;
  let posts_last_30_days = 0;
  const posts: PostSnapshot[] = [];

  for (const item of items) {
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

  return { cumulative_views, posts_last_30_days, follower_count, posts };
}

// Single-creator scrape — used by the manual "Sync now" button.
export async function scrapeTikTok(username: string, joinedAt?: string | null): Promise<ScrapedData> {
  const items = await apifyRunAndCollect({
    profiles: [`https://www.tiktok.com/@${normalizeHandle(username)}`],
    resultsPerPage: 100,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
  });
  const data = buildTikTokData(items, joinedAt);
  console.log(`[apify] TikTok @${username} — cumulative: ${data.cumulative_views}, posts (30d): ${data.posts_last_30_days}, followers: ${data.follower_count}`);
  return data;
}

export interface TikTokTarget {
  username: string;
  joinedAt?: string | null;
}

// ONE Apify run for many creators. The actor accepts a list of profile URLs and
// returns a flat array of videos across all of them; we group by author handle
// and build each creator's snapshot. This keeps the per-run startup overhead
// constant no matter how many creators we track — vs one run per creator, where
// that overhead is paid N times. Returns a map keyed by normalized handle.
export async function scrapeTikTokBatch(targets: TikTokTarget[]): Promise<Map<string, ScrapedData>> {
  const result = new Map<string, ScrapedData>();
  if (!targets.length) return result;

  // Pre-seed every requested creator with a zero result, so a creator the actor
  // returned nothing for still gets a (zero) snapshot rather than being skipped.
  for (const t of targets) result.set(normalizeHandle(t.username), buildTikTokData([], t.joinedAt));

  // Scale the poll timeout with batch size, capped so a single Vercel function
  // (maxDuration 300s) keeps headroom to store the snapshots afterward.
  const timeoutMs = Math.min(240_000, 60_000 + targets.length * 3_000);

  const items = await apifyRunAndCollect(
    {
      profiles: targets.map(t => `https://www.tiktok.com/@${normalizeHandle(t.username)}`),
      resultsPerPage: 100,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
    },
    timeoutMs
  );

  // Group the flat result list by author handle.
  const byAuthor = new Map<string, Record<string, unknown>[]>();
  for (const item of items) {
    const author = authorHandle(item);
    if (!author) continue;
    const list = byAuthor.get(author) ?? [];
    list.push(item);
    byAuthor.set(author, list);
  }

  for (const t of targets) {
    const key = normalizeHandle(t.username);
    result.set(key, buildTikTokData(byAuthor.get(key) ?? [], t.joinedAt));
  }

  console.log(`[apify] TikTok batch — ${targets.length} creators requested, ${items.length} videos, ${byAuthor.size} authors matched`);
  return result;
}

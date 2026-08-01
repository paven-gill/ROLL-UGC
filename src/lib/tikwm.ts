// ─── TikTok via tikwm (RapidAPI: tiktok-scraper7) ─────────────────────────────
//
// Drop-in replacement for the ScrapTik scraper. Returns the exact same
// `ScrapedData` shape, so nothing downstream (routes, storage, cycles, UI)
// changes. Selected at runtime by src/lib/tiktok.ts via TIKTOK_SCRAPER=tikwm.
//
// Why: ScrapTik's cheapest usable tier is $99/mo; tikwm's free tier is ~300
// requests/month, which comfortably covers a monthly (or weekly) TikTok sync of
// our creator count — TikTok is ~1.6% of total views, so monthly is plenty.
//
// tikwm is more efficient than ScrapTik: /user/posts takes the username directly,
// so there's NO separate username→id lookup — one paginated call chain per creator.
//
// Endpoint + fields (tikwm, aka tiktok-scraper7):
//   GET /user/posts?unique_id=<handle>&count=<n>&cursor=<c>
//     → { code:0, msg, data:{ videos:[{ video_id, create_time, play_count,
//         digg_count, comment_count, cover, author:{ follower_count } }],
//         cursor, hasMore } }
// Response shape is read defensively (field variants tolerated) and should be
// re-verified live via /api/sync/tiktok/test once TIKTOK_SCRAPER=tikwm is set.

import { type ScrapedData, type PostSnapshot, type TikTokTarget } from "./apify";

// Host is env-overridable in case the RapidAPI listing slug differs.
const TIKWM_HOST = (process.env.TIKWM_HOST ?? "tiktok-scraper7.p.rapidapi.com").trim();
const TIKWM_BASE = `https://${TIKWM_HOST}`;
const EP_USER_POSTS = "/user/posts";

// How many posts deep per creator (≈ last 3 months at 90). tikwm typically
// returns up to ~35 per page, so far fewer calls than ScrapTik's ~10/page.
const POSTS_LIMIT = Number(process.env.TIKTOK_POSTS_LIMIT) || 90;
const REQUEST_COUNT = 35;
const EST_PAGE_SIZE = 30;
const MAX_PAGES = Math.ceil(POSTS_LIMIT / EST_PAGE_SIZE) + 2;

const CONCURRENCY = 4;

// Global rate gate. The free tier is low-volume, so pace conservatively (~4 req/s)
// and let the 429 backoff absorb anything tighter.
const MIN_INTERVAL_MS = Number(process.env.TIKWM_MIN_INTERVAL_MS) || 250;
const MAX_RETRIES = 4;
let nextSlot = 0;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function rateGate(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + MIN_INTERVAL_MS;
  if (slot > now) await sleep(slot - now);
}

const normalizeHandle = (s: string) => s.trim().replace(/^@/, "").toLowerCase();

function rapidHeaders() {
  return {
    "Content-Type": "application/json",
    "x-rapidapi-host": TIKWM_HOST,
    "x-rapidapi-key": process.env.RAPIDAPI_KEY!,
  };
}

// Rate-gated GET with 429 backoff. Mirrors scraptikGet.
async function tikwmGet(path: string, attempt = 0): Promise<Record<string, unknown>> {
  await rateGate();
  const res = await fetch(`${TIKWM_BASE}${path}`, { headers: rapidHeaders() });
  if (res.status === 429 && attempt < MAX_RETRIES) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const backoff = retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
    await sleep(backoff);
    return tikwmGet(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`tikwm ${path} → ${res.status} ${res.statusText}`);
  const json = (await res.json()) as Record<string, unknown>;
  // tikwm signals logical errors with a non-zero `code` even on HTTP 200.
  if (json.code !== undefined && json.code !== 0 && json.code !== "0") {
    throw new Error(`tikwm ${path} → code ${json.code} ${json.msg ?? ""}`.trim());
  }
  return json;
}

const num = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : 0);

function isWithinDays(ts: number | string, days: number): boolean {
  const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return d >= cutoff;
}

// Unwrap the { data: {...} } envelope tikwm returns (tolerate a flat body too).
function readData(resp: Record<string, unknown>): Record<string, unknown> {
  return (resp.data as Record<string, unknown>) ?? resp;
}

// Pull the video list out of a posts-page response, tolerating field variants.
function readVideoList(data: Record<string, unknown>): Record<string, unknown>[] {
  return (
    (data.videos as Record<string, unknown>[]) ||
    (data.data as Record<string, unknown>[]) ||
    (data.items as Record<string, unknown>[]) ||
    (data.aweme_list as Record<string, unknown>[]) ||
    []
  );
}

// tikwm returns the thumbnail as a direct URL string on `cover`/`origin_cover`.
function readThumbnail(item: Record<string, unknown>): string | null {
  for (const key of ["cover", "origin_cover", "dynamic_cover", "ai_dynamic_cover"]) {
    const v = item[key];
    if (typeof v === "string" && v) return v;
    // Some variants nest it as { url_list: [...] }.
    const list = (v as Record<string, unknown>)?.url_list as string[] | undefined;
    if (Array.isArray(list) && typeof list[0] === "string" && list[0]) return list[0];
  }
  return null;
}

// tikwm keeps stats flat on the item (play_count) rather than under `statistics`,
// but read both so we're robust to either shape.
function stat(item: Record<string, unknown>, ...keys: string[]): number {
  const stats = (item.statistics as Record<string, unknown>) || {};
  for (const k of keys) {
    const v = item[k] ?? stats[k];
    if (typeof v === "number" && isFinite(v)) return v;
  }
  return 0;
}

// Turn tikwm's video list into our snapshot. Mirrors buildScraptikData so the
// output is identical in shape to every other provider.
function buildTikwmData(
  videos: Record<string, unknown>[],
  joinedAt?: string | null
): ScrapedData {
  const joinedAtTs = joinedAt ? new Date(joinedAt).getTime() : 0;

  const firstAuthor = (videos[0]?.author as Record<string, unknown>) || {};
  const follower_count = num(firstAuthor.follower_count) || num(firstAuthor.followerCount);

  let cumulative_views = 0;
  let posts_last_30_days = 0;
  const posts: PostSnapshot[] = [];

  for (const item of videos) {
    const createTime = num(item.create_time) || num(item.createTime);
    if (!createTime) continue;
    const dateStr = new Date(createTime * 1000).toISOString();
    if (isNaN(new Date(dateStr).getTime())) continue;
    if (joinedAtTs && new Date(dateStr).getTime() < joinedAtTs) continue;

    const playCount = stat(item, "play_count", "playCount");

    cumulative_views += playCount;
    if (isWithinDays(dateStr, 30)) posts_last_30_days++;

    posts.push({
      post_id: String(item.video_id || item.aweme_id || item.id || ""),
      platform: "tiktok",
      media_type: "video",
      taken_at: dateStr,
      view_count_used: playCount,
      view_field_used: playCount > 0 ? "play_count" : "none",
      like_count: stat(item, "digg_count", "diggCount"),
      comment_count: stat(item, "comment_count", "commentCount"),
      thumbnail_url: readThumbnail(item),
      raw_fields: { play_count: playCount },
    });
  }

  return { cumulative_views, posts_last_30_days, follower_count, posts };
}

// Paginate one creator's posts feed up to POSTS_LIMIT (or end of feed).
async function fetchCreatorPosts(handle: string): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor = "0";
  let page = 0;

  while (page < MAX_PAGES && all.length < POSTS_LIMIT) {
    page++;
    let data: Record<string, unknown>;
    try {
      data = readData(
        await tikwmGet(
          `${EP_USER_POSTS}?unique_id=${encodeURIComponent(handle)}&count=${REQUEST_COUNT}&cursor=${encodeURIComponent(cursor)}`
        )
      );
    } catch (e) {
      console.error(`[tikwm] page ${page} failed for @${handle}, keeping ${all.length} posts:`, e);
      break;
    }
    const items = readVideoList(data);
    if (items.length === 0) break;

    for (const item of items) {
      const id = String(item.video_id || item.aweme_id || item.id || "");
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      all.push(item);
    }

    const hasMore = data.hasMore === true || data.hasMore === 1 || data.has_more === true || data.has_more === 1;
    const nextCursor = String(data.cursor ?? data.max_cursor ?? "");
    if (!hasMore || !nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }

  return all.slice(0, POSTS_LIMIT);
}

// Resolve one handle → paginate posts → build snapshot.
async function scrapeOne(username: string, joinedAt?: string | null): Promise<ScrapedData> {
  const handle = normalizeHandle(username);
  const videos = await fetchCreatorPosts(handle);
  const data = buildTikwmData(videos, joinedAt);
  console.log(
    `[tikwm] @${handle} — cumulative: ${data.cumulative_views}, posts(30d): ${data.posts_last_30_days}, followers: ${data.follower_count}, scraped: ${videos.length}`
  );
  return data;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Public API — same signatures as the ScrapTik/Apify versions ────────────────

export async function scrapeTikTokTikwm(username: string, joinedAt?: string | null): Promise<ScrapedData> {
  return scrapeOne(username, joinedAt);
}

export async function scrapeTikTokTikwmBatch(targets: TikTokTarget[]): Promise<Map<string, ScrapedData>> {
  const result = new Map<string, ScrapedData>();
  if (!targets.length) return result;

  const settled = await mapWithConcurrency(targets, CONCURRENCY, async t => {
    try {
      return { key: normalizeHandle(t.username), data: await scrapeOne(t.username, t.joinedAt) };
    } catch (e) {
      console.error(`[tikwm] @${t.username} failed:`, e);
      return { key: normalizeHandle(t.username), data: buildTikwmData([], t.joinedAt) };
    }
  });

  for (const { key, data } of settled) result.set(key, data);
  console.log(`[tikwm] batch — ${targets.length} creators processed`);
  return result;
}

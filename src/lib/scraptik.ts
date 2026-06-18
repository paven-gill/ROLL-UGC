// ─── TikTok via ScrapTik (RapidAPI) ───────────────────────────────────────────
//
// Drop-in replacement for the Apify TikTok scraper. Returns the exact same
// `ScrapedData` shape, so nothing downstream (routes, storage, cycles, UI) needs
// to change. Selected at runtime by src/lib/tiktok.ts via the TIKTOK_SCRAPER env.
//
// Unlike Apify (one big run for all creators), ScrapTik is a per-account REST API:
// we look up each creator's profile, then paginate their posts feed. At ~100
// creators pulling ~90–180 posts each, this is a few thousand requests/month —
// a single-digit fraction of the ScrapTik Pro quota (400k/mo, 10 req/sec).
//
// Endpoint paths + response shapes below were verified live against ScrapTik
// (June 2026). The /api/sync/tiktok/test route prints results so you can re-check.

import { type ScrapedData, type PostSnapshot, type TikTokTarget } from "./apify";

const SCRAPTIK_HOST = "scraptik.p.rapidapi.com";
const SCRAPTIK_BASE = `https://${SCRAPTIK_HOST}`;

// Verified endpoints:
//   /username-to-id?username=<handle> → { uid, sec_uid }  (no follower count here)
//   /user-posts?user_id=<uid>&count=<n>&max_cursor=<c>
//     → { aweme_list:[{ aweme_id, create_time, statistics:{play_count,digg_count,
//         comment_count}, author:{follower_count}, video:{cover:{url_list}} }],
//         max_cursor, has_more (0|1) }
const EP_USERNAME_TO_ID = "/username-to-id";
const EP_USER_POSTS = "/user-posts";

// How many posts deep to go per creator (≈ last 3 months at 90, ~6 months at 180).
const POSTS_LIMIT = Number(process.env.TIKTOK_POSTS_LIMIT) || 90;
// We ask for REQUEST_COUNT but ScrapTik caps the page at ~10 (verified live), so
// the real stop condition is all.length >= POSTS_LIMIT. MAX_PAGES is just a safety
// cap, sized off the observed ~10/page so we can actually reach POSTS_LIMIT.
const REQUEST_COUNT = 35;
const EST_PAGE_SIZE = 10;
const MAX_PAGES = Math.ceil(POSTS_LIMIT / EST_PAGE_SIZE) + 2;

// How many creators are scraped concurrently. The global rate gate below is what
// actually caps request throughput, so this just keeps the pipeline full.
const CONCURRENCY = 6;

// ── Global rate gate ──────────────────────────────────────────────────────────
// ScrapTik Pro allows 10 req/sec; exceeding it returns 429. We schedule every
// request into a future time-slot spaced MIN_INTERVAL_MS apart, shared across all
// concurrent creators in this invocation, so collective throughput stays under the
// limit no matter how many lanes are running. ~8.3 req/s leaves headroom.
const MIN_INTERVAL_MS = 120;
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
    "x-rapidapi-host": SCRAPTIK_HOST,
    "x-rapidapi-key": process.env.RAPIDAPI_KEY!,
  };
}

// Rate-gated GET with backoff on 429. A single rate-limit hit used to throw and
// (in the batch) zero out the whole creator; now we wait and retry instead.
async function scraptikGet(path: string, attempt = 0): Promise<Record<string, unknown>> {
  await rateGate();
  const res = await fetch(`${SCRAPTIK_BASE}${path}`, { headers: rapidHeaders() });
  if (res.status === 429 && attempt < MAX_RETRIES) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const backoff = retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
    await sleep(backoff);
    return scraptikGet(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`ScrapTik ${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

const num = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : 0);

function isWithinDays(ts: number | string, days: number): boolean {
  const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return d >= cutoff;
}

// Pull the numeric user_id (uid) out of /username-to-id, tolerating a flat object
// or a { user/data }-wrapped one. follower_count isn't returned here — it comes
// from the author block on the posts feed instead.
function readUserId(resp: Record<string, unknown>): string | null {
  const u =
    (resp.user as Record<string, unknown>) ||
    (resp.data as Record<string, unknown>) ||
    resp;
  const uid = u.uid ?? u.user_id ?? u.id ?? u.userId;
  return uid !== undefined && uid !== null && String(uid) !== "" ? String(uid) : null;
}

// Pull the post list out of a posts-page response, tolerating field variants.
function readAwemeList(resp: Record<string, unknown>): Record<string, unknown>[] {
  return (
    (resp.aweme_list as Record<string, unknown>[]) ||
    (resp.awemeList as Record<string, unknown>[]) ||
    (resp.data as Record<string, unknown>[]) ||
    (resp.items as Record<string, unknown>[]) ||
    []
  );
}

function readThumbnail(item: Record<string, unknown>): string | null {
  const video = item.video as Record<string, unknown> | undefined;
  for (const key of ["cover", "origin_cover", "dynamic_cover"]) {
    const c = video?.[key] as Record<string, unknown> | undefined;
    const list = c?.url_list as string[] | undefined;
    if (Array.isArray(list) && typeof list[0] === "string" && list[0]) return list[0];
  }
  return null;
}

// Turn ScrapTik's aweme_list (+ profile follower count) into our snapshot.
// Mirrors buildTikTokData() in apify.ts so the output is identical in shape.
function buildScraptikData(
  awemes: Record<string, unknown>[],
  followerFromProfile: number,
  joinedAt?: string | null
): ScrapedData {
  const joinedAtTs = joinedAt ? new Date(joinedAt).getTime() : 0;

  // Fall back to the author block on the first post if the profile call gave 0.
  const firstAuthor = (awemes[0]?.author as Record<string, unknown>) || {};
  const follower_count = followerFromProfile || num(firstAuthor.follower_count) || num(firstAuthor.followerCount);

  let cumulative_views = 0;
  let posts_last_30_days = 0;
  const posts: PostSnapshot[] = [];

  for (const item of awemes) {
    const createTime = num(item.create_time) || num(item.createTime);
    if (!createTime) continue;
    const dateStr = new Date(createTime * 1000).toISOString();
    if (isNaN(new Date(dateStr).getTime())) continue;

    // Skip posts from before the creator joined.
    if (joinedAtTs && new Date(dateStr).getTime() < joinedAtTs) continue;

    const stats = (item.statistics as Record<string, unknown>) || {};
    const playCount = num(stats.play_count) || num(stats.playCount);

    cumulative_views += playCount;
    if (isWithinDays(dateStr, 30)) posts_last_30_days++;

    posts.push({
      post_id: String(item.aweme_id || item.aweme_id_str || item.id || ""),
      platform: "tiktok",
      media_type: "video",
      taken_at: dateStr,
      view_count_used: playCount,
      view_field_used: playCount > 0 ? "play_count" : "none",
      like_count: num(stats.digg_count) || num(stats.diggCount),
      comment_count: num(stats.comment_count) || num(stats.commentCount),
      thumbnail_url: readThumbnail(item),
      raw_fields: { play_count: stats.play_count },
    });
  }

  return { cumulative_views, posts_last_30_days, follower_count, posts };
}

// Paginate one creator's posts feed up to POSTS_LIMIT (or end of feed).
async function fetchCreatorPosts(userId: string): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor = "0";
  let page = 0;

  while (page < MAX_PAGES && all.length < POSTS_LIMIT) {
    page++;
    let resp: Record<string, unknown>;
    try {
      resp = await scraptikGet(
        `${EP_USER_POSTS}?user_id=${encodeURIComponent(userId)}&count=${REQUEST_COUNT}&max_cursor=${encodeURIComponent(cursor)}`
      );
    } catch (e) {
      // A page that still fails after retries shouldn't discard the posts we
      // already have — keep the partial result rather than zeroing the creator.
      console.error(`[scraptik] page ${page} failed for user ${userId}, keeping ${all.length} posts:`, e);
      break;
    }
    const items = readAwemeList(resp);
    if (items.length === 0) break;

    for (const item of items) {
      const id = String(item.aweme_id || item.aweme_id_str || item.id || "");
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      all.push(item);
    }

    const hasMore = resp.has_more === true || resp.has_more === 1 || resp.hasMore === true;
    const nextCursor = String(resp.max_cursor ?? resp.maxCursor ?? "");
    if (!hasMore || !nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
    // No explicit delay here — the global rate gate in scraptikGet handles spacing.
  }

  return all.slice(0, POSTS_LIMIT);
}

// Resolve user_id → paginate posts → build snapshot, for a single handle.
async function scrapeOne(username: string, joinedAt?: string | null): Promise<ScrapedData> {
  const handle = normalizeHandle(username);
  const lookup = await scraptikGet(`${EP_USERNAME_TO_ID}?username=${encodeURIComponent(handle)}`);
  const userId = readUserId(lookup);
  if (!userId) throw new Error(`ScrapTik: could not resolve user_id for @${handle}`);

  const awemes = await fetchCreatorPosts(userId);
  // follower_count comes from the author block on the posts (0 → buildScraptikData
  // falls back to the first aweme's author.follower_count).
  const data = buildScraptikData(awemes, 0, joinedAt);
  console.log(
    `[scraptik] @${handle} — cumulative: ${data.cumulative_views}, posts(30d): ${data.posts_last_30_days}, followers: ${data.follower_count}, scraped: ${awemes.length}`
  );
  return data;
}

// Run an async fn over items with a fixed concurrency cap (keeps us under the
// ScrapTik rate limit while still finishing the nightly batch quickly).
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

// ── Public API — same signatures as the Apify versions in apify.ts ─────────────

// Single-creator scrape (manual "Sync now" button).
export async function scrapeTikTokScraptik(username: string, joinedAt?: string | null): Promise<ScrapedData> {
  return scrapeOne(username, joinedAt);
}

// Many creators — concurrency-limited fan-out. Returns a map keyed by normalized
// handle, identical to scrapeTikTokBatch(). A single creator failing doesn't sink
// the batch: it gets a zero snapshot and we move on.
export async function scrapeTikTokScraptikBatch(targets: TikTokTarget[]): Promise<Map<string, ScrapedData>> {
  const result = new Map<string, ScrapedData>();
  if (!targets.length) return result;

  const settled = await mapWithConcurrency(targets, CONCURRENCY, async t => {
    try {
      return { key: normalizeHandle(t.username), data: await scrapeOne(t.username, t.joinedAt) };
    } catch (e) {
      console.error(`[scraptik] @${t.username} failed:`, e);
      return { key: normalizeHandle(t.username), data: buildScraptikData([], 0, t.joinedAt) };
    }
  });

  for (const { key, data } of settled) result.set(key, data);
  console.log(`[scraptik] batch — ${targets.length} creators processed`);
  return result;
}

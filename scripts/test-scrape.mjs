/**
 * Local RapidAPI scrape test — no Next.js needed.
 * Usage:  node scripts/test-scrape.mjs [instagram-username]
 *
 * If no username is supplied, looks up "alpha" in Supabase creators table.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

// ── Load .env.local ──────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");
const envLines = readFileSync(envPath, "utf8").split("\n");
for (const line of envLines) {
  const m = line.match(/^([^#=][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const IG_BASE = "https://instagram-looter2.p.rapidapi.com";

if (!RAPIDAPI_KEY) {
  console.error("❌  RAPIDAPI_KEY not found in .env.local");
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function rapidHeaders() {
  return {
    "Content-Type": "application/json",
    "x-rapidapi-host": "instagram-looter2.p.rapidapi.com",
    "x-rapidapi-key": RAPIDAPI_KEY,
  };
}

async function igGet(path) {
  const url = `${IG_BASE}${path}`;
  console.log(`  → GET ${url.split("?")[0]}…`);
  const res = await fetch(url, { headers: rapidHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`RapidAPI ${path} → ${res.status} ${res.statusText} | ${body.slice(0, 200)}`);
  }
  return res.json();
}

function isWithinDays(ts, days) {
  const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return d >= cutoff;
}

function getViewCount(item) {
  const checks = [
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

function getThumbnailUrl(p) {
  if (typeof p.thumbnail_url === "string" && p.thumbnail_url) return p.thumbnail_url;
  if (typeof p.display_url === "string" && p.display_url) return p.display_url;
  const iv2 = p.image_versions2;
  if (iv2?.candidates?.[0]?.url) return iv2.candidates[0].url;
  const carousel = p.carousel_media;
  if (carousel?.[0]?.image_versions2?.candidates?.[0]?.url)
    return carousel[0].image_versions2.candidates[0].url;
  return null;
}

function fmt(n) {
  return n >= 1_000_000
    ? (n / 1_000_000).toFixed(2) + "M"
    : n >= 1_000
    ? (n / 1_000).toFixed(1) + "K"
    : String(n);
}

function pad(str, len) {
  return String(str).padEnd(len);
}

async function fetchFeedForViewCounts(endpoint, stopBeforeTs) {
  const all = [];
  const seenIds = new Set();
  let cursor = null;
  let page = 0;
  const MAX_PAGES = 30;

  while (page < MAX_PAGES) {
    page++;
    const url = cursor ? `${endpoint}&cursor=${encodeURIComponent(cursor)}` : endpoint;
    const data = await igGet(url);
    const items = data.items || data.data || [];

    if (items.length === 0) break;

    let newThisPage = 0;
    let dupeCount = 0;
    let oldCount = 0;

    for (const item of items) {
      // Use code (shortcode) — pk from /user-feeds is a JS Number and loses
      // precision on 64-bit Instagram IDs, breaking cross-endpoint dedup.
      const itemId = String(item.code || item.shortcode || item.pk || item.id || "");
      if (itemId && seenIds.has(itemId)) { dupeCount++; continue; }
      if (itemId) seenIds.add(itemId);

      if (stopBeforeTs) {
        const ts = item.taken_at;
        if (ts !== undefined && ts < stopBeforeTs) { oldCount++; continue; }
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

    console.log(
      `     page ${page}: ${items.length} raw | ${newThisPage} new | ${dupeCount} dupes | ${oldCount} pre-cutoff | running total: ${all.length}`
    );

    if (dupeCount === items.length) {
      console.log("     ⚠  full-page duplicates — API cycling, stopping");
      break;
    }
    if (!nextCursor) break;
    cursor = String(nextCursor);

    await new Promise(r => setTimeout(r, 300));
  }

  return all;
}

// ── Core scrape ──────────────────────────────────────────────────────────────
async function scrapeInstagram(username, joinedAt) {
  console.log(`\n📡  Fetching profile for @${username}…`);
  const profile = await igGet(`/profile?username=${username}`);

  const userId = profile.pk || profile.id || profile.user_id;
  const follower_count =
    profile.edge_followed_by?.count ||
    profile.follower_count ||
    profile.followersCount ||
    0;

  if (!userId) throw new Error(`Could not find user ID for @${username}`);
  console.log(`    userId: ${userId}  |  followers: ${fmt(follower_count)}`);

  const stopBeforeTs = joinedAt ? Math.floor(new Date(joinedAt).getTime() / 1000) : undefined;
  if (stopBeforeTs) {
    console.log(`    joined_at cutoff: ${joinedAt} (ts ${stopBeforeTs})`);
  }

  console.log(`\n📽   Fetching /reels (paginated)…`);
  const filteredReels = [];
  let reelMaxId = null;
  let reelPage = 0;
  let hitCutoff = false;

  while (reelPage < 30 && !hitCutoff) {
    reelPage++;
    const url = reelMaxId
      ? `/reels?id=${userId}&max_id=${encodeURIComponent(reelMaxId)}`
      : `/reels?id=${userId}`;
    const reelsResp = await igGet(url);
    const pageItems = (reelsResp.items || reelsResp.data || []).map(i => i.media ?? i);

    let added = 0;
    for (const p of pageItems) {
      if (p.media_type !== undefined && p.media_type !== 2) continue;
      if (stopBeforeTs) {
        const raw = p.taken_at || p.timestamp || p.created_at;
        if (raw) {
          const ts = typeof raw === "string" ? Math.floor(new Date(raw).getTime() / 1000) : raw;
          if (ts < stopBeforeTs) { hitCutoff = true; continue; }
        }
      }
      filteredReels.push(p);
      added++;
    }

    const pi = reelsResp.paging_info;
    reelMaxId = pi?.more_available ? pi.max_id : null;
    console.log(`    page ${reelPage}: ${pageItems.length} raw → ${added} kept, total: ${filteredReels.length}${reelMaxId ? "" : " (done)"}`);

    if (!reelMaxId) break;
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`    ${filteredReels.length} reels after cutoff filter`);

  console.log(`\n🔄  Fetching feed pages for view counts…`);
  const feedItems = await fetchFeedForViewCounts(
    `/user-feeds?id=${userId}&count=50&allow_restricted_media=false`,
    stopBeforeTs
  );
  const feedReels = feedItems.filter(p => p.media_type === 2);
  console.log(`    ${feedItems.length} feed items → ${feedReels.length} reels`);

  const postId = item => String(item.code || item.shortcode || item.pk || item.id || "");

  const feedMap = new Map();
  for (const item of feedReels) {
    const id = postId(item);
    if (id) feedMap.set(id, item);
  }

  const reelIds = new Set(filteredReels.map(postId));
  const mergedReels = filteredReels.map(reel => {
    const id = postId(reel);
    const feedItem = feedMap.get(id);
    return feedItem ? { ...reel, ...feedItem } : reel;
  });
  for (const feedReel of feedReels) {
    const id = postId(feedReel);
    if (id && !reelIds.has(id)) mergedReels.push(feedReel);
  }
  mergedReels.sort((a, b) => ((b.taken_at) || 0) - ((a.taken_at) || 0));

  let cumulative_views = 0;
  let posts_last_30_days = 0;
  let posts_with_zero_views = 0;
  const posts = [];

  for (const p of mergedReels) {
    const { views, field } = getViewCount(p);
    const takenAtRaw = p.taken_at || p.timestamp || p.created_at;
    const takenAt = takenAtRaw
      ? (typeof takenAtRaw === "number"
          ? new Date(takenAtRaw * 1000).toISOString()
          : String(takenAtRaw))
      : null;

    if (views === 0) posts_with_zero_views++;
    cumulative_views += views;
    if (takenAtRaw && isWithinDays(takenAtRaw, 30)) posts_last_30_days++;

    posts.push({
      post_id: postId(p),
      taken_at: takenAt,
      view_count: views,
      view_field: field,
      like_count: typeof p.like_count === "number" ? p.like_count : 0,
      comment_count: typeof p.comment_count === "number" ? p.comment_count : 0,
      thumbnail_url: getThumbnailUrl(p),
    });
  }

  return {
    userId,
    follower_count,
    cumulative_views,
    posts_last_30_days,
    posts_with_zero_views,
    total_posts: posts.length,
    posts,
  };
}

// ── Lookup creator from Supabase ─────────────────────────────────────────────
async function findCreator(nameSearch) {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  const { data, error } = await sb
    .from("creators")
    .select("*")
    .ilike("name", `%${nameSearch}%`)
    .limit(5);
  if (error) throw new Error(`Supabase error: ${error.message}`);
  return data ?? [];
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const arg = process.argv[2];
  let username = arg;
  let joinedAt = null;
  let creatorName = username;

  if (!username) {
    // Look up in database — search for alfie/alpha, fallback to first active creator
    console.log("🔍  Looking up creator in Supabase…");
    let creators = await findCreator("alfie");
    if (!creators.length) creators = await findCreator("alpha");
    if (!creators.length) {
      // Fallback: grab the first active Instagram creator
      const sb = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      );
      const { data } = await sb
        .from("creators")
        .select("*")
        .eq("active", true)
        .not("instagram_username", "is", null)
        .limit(1);
      creators = data ?? [];
    }
    if (!creators.length) {
      console.error("❌  No active Instagram creator found in database.");
      console.error("    Usage: node scripts/test-scrape.mjs <instagram-username>");
      process.exit(1);
    }
    const creator = creators[0];
    console.log(`    Found: ${creator.name} (id: ${creator.id})`);
    console.log(`    Instagram: @${creator.instagram_username}  |  joined: ${creator.joined_at}`);
    username = creator.instagram_username;
    joinedAt = creator.joined_at;
    creatorName = creator.name;

    if (!username) {
      console.error("❌  Creator has no instagram_username set.");
      process.exit(1);
    }
  }

  const startTime = Date.now();
  const result = await scrapeInstagram(username, joinedAt);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // ── Print report ────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(70));
  console.log(`  SCRAPE REPORT — ${creatorName} (@${username})`);
  console.log("═".repeat(70));
  console.log(`  Followers          : ${fmt(result.follower_count)}`);
  console.log(`  Total posts found  : ${result.total_posts}`);
  console.log(`  Posts last 30 days : ${result.posts_last_30_days}`);
  console.log(`  Cumulative views   : ${fmt(result.cumulative_views)}`);
  console.log(`  Posts with 0 views : ${result.posts_with_zero_views} (${((result.posts_with_zero_views / Math.max(result.total_posts, 1)) * 100).toFixed(0)}%)`);
  console.log(`  Elapsed            : ${elapsed}s`);
  console.log("═".repeat(70));

  if (result.posts.length > 0) {
    console.log(`\n  ${"DATE".padEnd(12)} ${"VIEWS".padStart(10)} ${"LIKES".padStart(8)} ${"COMMENTS".padStart(10)}  ${"VIEW FIELD"}`);
    console.log("  " + "─".repeat(68));
    for (const p of result.posts.slice(0, 50)) {
      const date = p.taken_at ? p.taken_at.slice(0, 10) : "unknown";
      const flag = isWithinDays(p.taken_at ?? 0, 30) ? " ◀ 30d" : "";
      console.log(
        `  ${pad(date, 12)} ${pad(fmt(p.view_count), 10)} ${pad(fmt(p.like_count), 8)} ${pad(fmt(p.comment_count), 10)}  ${p.view_field}${flag}`
      );
    }
    if (result.posts.length > 50) {
      console.log(`  … and ${result.posts.length - 50} more posts`);
    }
  }

  // Data quality analysis
  const zeroViewPosts = result.posts.filter(p => p.view_count === 0);
  const viewFields = {};
  for (const p of result.posts) {
    viewFields[p.view_field] = (viewFields[p.view_field] || 0) + 1;
  }

  console.log("\n  DATA QUALITY");
  console.log("  " + "─".repeat(40));
  console.log("  View fields used:");
  for (const [field, count] of Object.entries(viewFields)) {
    console.log(`    ${pad(field, 35)} × ${count}`);
  }
  if (zeroViewPosts.length > 0) {
    console.log(`\n  ⚠  ${zeroViewPosts.length} posts returned 0 views — these are likely:`);
    console.log("     • Too recent (counts not populated yet)");
    console.log("     • Hidden/restricted reels");
    console.log("     • Only available via /reels, not the feed endpoint");
  }

  console.log("\n" + "═".repeat(70));
}

main().catch(err => {
  console.error("\n❌  Error:", err.message || err);
  process.exit(1);
});

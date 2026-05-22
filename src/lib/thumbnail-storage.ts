import { createServerClient } from "./supabase";
import type { PostSnapshot } from "./apify";

const BUCKET = "thumbnails";
const TOP_N = 8;
const TTL_DAYS = 30;

// Upload Supabase-stored cover for the top N TikTok posts (by view count) for one creator.
// For posts already in storage, just points post_snapshots at the stored URL.
// For new top-N posts, downloads from the (fresh, just-scraped) CDN URL and uploads.
export async function uploadTopTikTokThumbs(
  db: ReturnType<typeof createServerClient>,
  creatorId: string,
  posts: PostSnapshot[]   // all posts returned from this sync (CDN URLs still live)
): Promise<void> {
  const top = [...posts]
    .sort((a, b) => b.view_count_used - a.view_count_used)
    .slice(0, TOP_N)
    .filter(p => p.thumbnail_url);

  if (top.length === 0) return;

  // One list call to check which are already stored
  const { data: existing } = await db.storage.from(BUCKET).list("tiktok", { limit: 1000 });
  const storedIds = new Set((existing ?? []).map(f => f.name));

  await Promise.all(top.map(async post => {
    const path = `tiktok/${post.post_id}`;

    if (storedIds.has(post.post_id)) {
      // Already in storage — just re-point the DB row at the stable URL
      const { data: urlData } = db.storage.from(BUCKET).getPublicUrl(path);
      await db.from("post_snapshots")
        .update({ thumbnail_url: urlData.publicUrl })
        .eq("post_id", post.post_id)
        .eq("creator_id", creatorId);
      return;
    }

    try {
      const res = await fetch(post.thumbnail_url!, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible)" },
      });
      if (!res.ok) return;

      const buffer = await res.arrayBuffer();
      const contentType = res.headers.get("content-type") ?? "image/jpeg";

      const { error } = await db.storage.from(BUCKET).upload(path, buffer, {
        contentType,
        upsert: true,
      });
      if (error) { console.error(`[thumbnails] upload failed ${post.post_id}:`, error.message); return; }

      const { data: urlData } = db.storage.from(BUCKET).getPublicUrl(path);
      await db.from("post_snapshots")
        .update({ thumbnail_url: urlData.publicUrl })
        .eq("post_id", post.post_id)
        .eq("creator_id", creatorId);

      console.log(`[thumbnails] stored ${post.post_id}`);
    } catch (e) {
      console.error(`[thumbnails] error uploading ${post.post_id}:`, e);
    }
  }));
}

// Run after the nightly cron finishes all creators.
// Keeps only the top-8 TikTok thumbs per active creator that are within 30 days.
// Everything else is deleted from storage.
export async function cleanupTikTokThumbs(
  db: ReturnType<typeof createServerClient>
): Promise<void> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - TTL_DAYS);

  const { data: creators } = await db.from("creators").select("id").eq("active", true);
  const keepIds = new Set<string>();

  for (const creator of creators ?? []) {
    const { data: posts } = await db
      .from("post_snapshots")
      .select("post_id, taken_at")
      .eq("creator_id", creator.id)
      .eq("platform", "tiktok")
      .order("view_count_used", { ascending: false })
      .limit(TOP_N);

    for (const post of posts ?? []) {
      if (post.taken_at && new Date(post.taken_at) >= cutoff) {
        keepIds.add(post.post_id);
      }
    }
  }

  const { data: allFiles } = await db.storage.from(BUCKET).list("tiktok", { limit: 1000 });
  const toDelete = (allFiles ?? [])
    .filter(f => !keepIds.has(f.name))
    .map(f => `tiktok/${f.name}`);

  if (toDelete.length === 0) return;

  const { error } = await db.storage.from(BUCKET).remove(toDelete);
  if (error) console.error("[thumbnails] cleanup error:", error.message);
  else console.log(`[thumbnails] deleted ${toDelete.length} expired thumbnails`);
}

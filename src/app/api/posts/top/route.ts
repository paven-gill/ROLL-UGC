import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAuth, allowedCreatorIds, isAuthError } from "@/lib/auth";
import { fetchAllRows } from "@/lib/fetch-all";

// GET /api/posts/top
//
// Batched posts for the home page: returns every in-scope creator's posts keyed
// by creator_id, in ONE request. The home "All creators" view used to fetch
// /api/posts/{id} once per creator (18 round-trips, 18 auth+scope checks); this
// collapses that into a single call returning the same rows, so the page builds
// the identical per-creator lists (and identical Total Posts count) it did before.
// Paged so it can't silently drop rows at Supabase's 1000-row read cap.

type PostRow = {
  creator_id: string;
  post_id: string;
  platform: string;
  media_type: string | null;
  taken_at: string | null;
  view_count_used: number;
  view_field_used: string;
  like_count: number;
  comment_count: number;
  thumbnail_url: string | null;
  synced_at: string;
};

export async function GET(req: Request) {
  try {
    const ctx = await requireAuth(req);
    const db = createServerClient();
    const ids = await allowedCreatorIds(db, ctx);

    const rows = await fetchAllRows<PostRow>((from, to) => {
      const q = db
        .from("post_snapshots")
        .select(
          "creator_id, post_id, platform, media_type, taken_at, view_count_used, view_field_used, like_count, comment_count, thumbnail_url, synced_at"
        )
        .order("taken_at", { ascending: false })
        .range(from, to);
      if (ids !== null) q.in("creator_id", ids);
      return q;
    });

    // Group by creator, preserving the global taken_at-desc order so each creator's
    // rows stay newest-first. Cap at 200 per creator to exactly match the old
    // per-creator query (.order(taken_at desc).limit(200)) — same rows, same counts.
    const byCreator: Record<string, PostRow[]> = {};
    for (const r of rows) {
      const arr = (byCreator[r.creator_id] ??= []);
      if (arr.length < 200) arr.push(r);
    }

    return NextResponse.json(byCreator);
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

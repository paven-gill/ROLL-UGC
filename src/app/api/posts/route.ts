import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAuth, allowedCreatorIds, scopeToCreators, isAuthError } from "@/lib/auth";

export async function GET(req: Request) {
  try {
  const ctx = await requireAuth(req);
  const db = createServerClient();
  const ids = await allowedCreatorIds(db, ctx);
  const { data, error } = await scopeToCreators(db
    .from("post_snapshots")
    .select("post_id, platform, media_type, taken_at, view_count_used, view_field_used, like_count, comment_count, thumbnail_url, synced_at")
    .order("view_count_used", { ascending: false })
    .limit(8), ids);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

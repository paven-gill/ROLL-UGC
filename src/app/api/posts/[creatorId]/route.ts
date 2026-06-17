import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAuth, assertCreatorInScope, isAuthError } from "@/lib/auth";

export async function GET(
  req: Request,
  { params }: { params: { creatorId: string } }
) {
  try {
  const ctx = await requireAuth(req);
  const db = createServerClient();
  await assertCreatorInScope(db, ctx, params.creatorId);
  const { data, error } = await db
    .from("post_snapshots")
    .select("post_id, platform, media_type, taken_at, view_count_used, view_field_used, like_count, comment_count, thumbnail_url, synced_at")
    .eq("creator_id", params.creatorId)
    .order("taken_at", { ascending: false })
    .limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

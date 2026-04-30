import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export async function GET() {
  const db = createServerClient();
  const { data, error } = await db
    .from("post_snapshots")
    .select("post_id, platform, media_type, taken_at, view_count_used, view_field_used, like_count, comment_count, thumbnail_url, synced_at")
    .order("view_count_used", { ascending: false })
    .limit(8);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

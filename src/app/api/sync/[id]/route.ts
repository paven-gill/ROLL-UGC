import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { scrapeInstagram } from "@/lib/apify";
import { scrapeTikTok } from "@/lib/tiktok";
import { storeSnapshot, processCycle } from "@/lib/sync-core";
import { requireAuth, assertCreatorInScope, isAuthError } from "@/lib/auth";

export const maxDuration = 300;

// ─── POST /api/sync/[id] ──────────────────────────────────────────────────────
//
// Syncs a single creator. Two callers:
//   • The manual "Sync now" button — no params, syncs BOTH platforms for that
//     one creator (the fallback for when something didn't sync cleanly).
//   • The nightly cron fan-out — passes ?skipTiktok=1, because TikTok for every
//     creator was already done in one batched Apify run (POST /api/sync/tiktok)
//     before the fan-out. So these children only do Instagram + the cycle check.

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const db = createServerClient();

  // Allow the cron (CRON_SECRET) OR a logged-in user who owns this creator's
  // campaign (Owner inside the campaign, or the brand's Manager).
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    try {
      const ctx = await requireAuth(req);
      await assertCreatorInScope(db, ctx, params.id);
    } catch (e) {
      if (isAuthError(e)) return e.response;
      throw e;
    }
  }

  const skipTiktok = new URL(req.url).searchParams.get("skipTiktok") === "1";

  const { data: creator, error } = await db
    .from("creators")
    .select("*")
    .eq("id", params.id)
    .single();

  if (error) return NextResponse.json({ error: "Creator not found" }, { status: 404 });

  console.log(`[sync] Starting sync for: ${creator.name}${skipTiktok ? " (instagram only)" : ""}`);
  const result: Record<string, unknown> = { name: creator.name };

  // Sync each platform (store daily snapshots + post data)
  if (creator.instagram_username) {
    try {
      const data = await scrapeInstagram(creator.instagram_username, creator.joined_at);
      await storeSnapshot(db, creator.id, "instagram", data);
      result.instagram = { cumulative_views: data.cumulative_views };
    } catch (e) {
      console.error("[sync] Instagram error:", e);
      result.instagram_error = String(e);
    }
  }

  if (creator.tiktok_username && !skipTiktok) {
    try {
      const data = await scrapeTikTok(creator.tiktok_username, creator.joined_at);
      await storeSnapshot(db, creator.id, "tiktok", data);
      result.tiktok = { cumulative_views: data.cumulative_views };
    } catch (e) {
      console.error("[sync] TikTok error:", e);
      result.tiktok_error = String(e);
    }
  }

  // After ALL platforms are synced: process the cycle. This auto-stamps a finished
  // cycle as a pending payout and rolls into the next one once its term is over.
  try {
    result.cycle = await processCycle(db, creator);
  } catch (e) {
    console.error("[sync] Cycle process error:", e);
    result.cycle_error = String(e);
  }

  console.log("[sync] Done:", result);
  return NextResponse.json({ ...result, synced_at: new Date().toISOString() });
}

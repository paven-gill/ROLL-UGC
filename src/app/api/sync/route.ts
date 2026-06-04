import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { cleanupTikTokThumbs } from "@/lib/thumbnail-storage";

export const maxDuration = 300;

// ─── GET /api/sync (daily cron at 11:55pm UTC) ────────────────────────────────
//
// Fan-out orchestrator. Instead of syncing every creator sequentially inside
// this one function (which blew past the 300s limit and starved whoever was
// last in line), we fire one independent POST /api/sync/[id] invocation per
// creator, all in parallel. Each child:
//   • runs as its own Vercel function with its own fresh 300s budget, so no
//     creator can starve another, and
//   • persists its own snapshot independently — so even if THIS parent times
//     out, every child that already finished has committed its data.
//
// Wall-clock for the whole batch ≈ the slowest single creator (~1–3 min),
// not the sum of all of them.

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function triggerCreatorSync(
  baseUrl: string,
  creator: { id: string; name: string }
): Promise<Record<string, unknown>> {
  const url = `${baseUrl}/api/sync/${creator.id}`;
  // One retry to ride out transient network / cold-start hiccups.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return { status: "ok", name: creator.name, ...(await res.json()) };
    } catch (e) {
      if (attempt === 2) {
        return { status: "error", name: creator.name, error: String(e) };
      }
      await sleep(2000);
    }
  }
  // Unreachable, but keeps TS happy.
  return { status: "error", name: creator.name, error: "unknown" };
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createServerClient();
  const { data: creators, error } = await db
    .from("creators")
    .select("id,name")
    .eq("active", true);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Where to send the self-calls. IMPORTANT: do NOT use VERCEL_URL — it's the
  // per-deployment domain (e.g. project-<hash>.vercel.app), which sits behind
  // Vercel Deployment Protection. Self-calls to it get bounced with a 401 auth
  // page before they reach the function, so every child silently fails.
  // VERCEL_PROJECT_PRODUCTION_URL is the stable production domain, which the
  // protection layer lets through. SYNC_BASE_URL overrides both (local dev /
  // custom domain). VERCEL_URL stays only as a last-resort fallback.
  const baseUrl =
    process.env.SYNC_BASE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : null) ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);

  if (!baseUrl) {
    return NextResponse.json(
      { error: "No base URL — set SYNC_BASE_URL (or deploy on Vercel)" },
      { status: 500 }
    );
  }

  const list = creators ?? [];

  // Fire all children. We stagger the *launches* by 250ms to avoid a thundering
  // herd on the upstream APIs, but we do NOT wait for one to finish before
  // launching the next — they all run concurrently. Promise.allSettled waits
  // for the whole batch.
  const settled = await Promise.allSettled(
    list.map(async (creator, i) => {
      await sleep(i * 250);
      return triggerCreatorSync(baseUrl, creator);
    })
  );

  const results = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : { status: "error", name: list[i]?.name, error: String(s.reason) }
  );

  // Run thumbnail cleanup once, after the per-creator children have written.
  try {
    await cleanupTikTokThumbs(db);
  } catch (e) {
    console.error("[sync] thumbnail cleanup error:", e);
  }

  const ok = results.filter(r => r.status === "ok").length;
  const failed = results.length - ok;
  console.log(`[sync] fan-out complete: ${ok} ok, ${failed} failed of ${results.length}`);

  return NextResponse.json({
    triggered: results.length,
    ok,
    failed,
    results,
    synced_at: new Date().toISOString(),
  });
}

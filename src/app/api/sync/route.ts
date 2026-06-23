import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { cleanupTikTokThumbs } from "@/lib/thumbnail-storage";
import { businessDayOfMonth } from "@/lib/date";

export const maxDuration = 300;

// ─── TikTok scrape cadence ────────────────────────────────────────────────────
// Both platforms now sync EVERY night. TikTok used to be throttled to every Nth
// day because the legacy Apify scraper was pay-per-result; ScrapTik (the current
// default) is a flat-quota RapidAPI plan with plenty of headroom, so there's no
// cost reason to skip nights anymore — daily keeps payout cycles fully fresh.
//
// The every-Nth-day gate is kept only as a retune knob: set TIKTOK_SYNC_EVERY_DAYS
// to >1 to anchor TikTok to the day-of-month again (runs on the 1st, 1+N, …).
// Default 1 = run every night.
const TIKTOK_SYNC_EVERY_DAYS = Number(process.env.TIKTOK_SYNC_EVERY_DAYS) || 1;

function isTikTokSyncDay(): boolean {
  // N<=1 means run every night. (Guard: `x % 1` is always 0, so without this a
  // value of 1 would never match `=== 1` and would silently disable TikTok.)
  if (TIKTOK_SYNC_EVERY_DAYS <= 1) return true;
  return businessDayOfMonth() % TIKTOK_SYNC_EVERY_DAYS === 1;
}

// ─── GET /api/sync (daily cron at 11:55pm UTC) ────────────────────────────────
//
// Two-phase orchestrator:
//
//   Phase 1 — TikTok, batched. One POST /api/sync/tiktok scrapes EVERY creator's
//     TikTok in a single Apify run and commits their snapshots. This is the cost
//     fix: the Apify run's startup overhead is paid once per night instead of
//     once per creator, so the bill stops scaling linearly with creator count.
//     We await it so every TikTok snapshot is committed before phase 2's cycle
//     checks read today's view totals.
//
//   Phase 2 — Instagram, fanned out. One independent POST /api/sync/[id]?skipTiktok=1
//     per creator, all in parallel. Each child:
//       • runs as its own Vercel function with its own fresh 300s budget, so no
//         creator can starve another, and
//       • persists its own snapshot independently — so even if THIS parent times
//         out, every child that already finished has committed its data.
//     (Instagram stays per-creator because it's RapidAPI, billed per request,
//     not per run — there's no batching win there.)
//
// Wall-clock ≈ batched TikTok run + the slowest single Instagram creator.

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function triggerCreatorSync(
  baseUrl: string,
  creator: { id: string; name: string }
): Promise<Record<string, unknown>> {
  const url = `${baseUrl}/api/sync/${creator.id}?skipTiktok=1`;
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

  // ── Phase 1: batched TikTok for all creators in one Apify run ──────────────
  // Only on TikTok days (every TIKTOK_SYNC_EVERY_DAYS) — Instagram still runs
  // nightly below regardless. Awaited so every TikTok snapshot is committed
  // before the Instagram children run their cycle checks. A failure here is
  // non-fatal — we log it and still run Instagram; the manual "Sync now" button
  // is the per-creator fallback.
  let tiktok: Record<string, unknown>;
  if (!isTikTokSyncDay()) {
    tiktok = { status: "skipped", reason: `not a TikTok day (every ${TIKTOK_SYNC_EVERY_DAYS}d)` };
    console.log(`[sync] TikTok skipped — not a TikTok day (every ${TIKTOK_SYNC_EVERY_DAYS}d)`);
  } else {
    try {
      const res = await fetch(`${baseUrl}/api/sync/tiktok`, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      });
      tiktok = res.ok
        ? { status: "ok", ...(await res.json()) }
        : { status: "error", error: `HTTP ${res.status} ${res.statusText}` };
    } catch (e) {
      console.error("[sync] batched TikTok failed:", e);
      tiktok = { status: "error", error: String(e) };
    }
  }

  // ── Phase 2: fan out Instagram (+ cycle check) per creator ─────────────────
  // We stagger the *launches* by 250ms to avoid a thundering herd on the upstream
  // APIs, but we do NOT wait for one to finish before launching the next — they
  // all run concurrently. Promise.allSettled waits for the whole batch.
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
    tiktok,
    triggered: results.length,
    ok,
    failed,
    results,
    synced_at: new Date().toISOString(),
  });
}

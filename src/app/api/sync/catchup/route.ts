import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { resolveSyncBaseUrl } from "@/lib/sync-core";
import { businessDate } from "@/lib/date";
import { getAuthContext } from "@/lib/auth";

// Long budget: when this DOES trigger a catch-up, it awaits the full /api/sync
// run (same ~minutes budget as the nightly cron).
export const maxDuration = 300;

// Don't re-fire a catch-up within this window. A single page can produce many
// concurrent loads (multiple tabs/users), and the snapshots take a couple
// minutes to land after we trigger — without this, every one of those loads
// would kick its own sync. The lock lives in app_settings.catchup_state.
const THROTTLE_MS = 15 * 60 * 1000;
const LOCK_KEY = "catchup_state";

// ─── GET /api/sync/catchup ────────────────────────────────────────────────────
//
// Self-heal for a missed nightly run. The 23:55 UTC cron can be skipped if a
// deployment is swapping at exactly that moment (a deploy was building when the
// run was due on 23 Jun 2026, and that day silently got no data). This endpoint
// is the safety net, triggered two ways:
//   • a backup cron a few hours later (vercel.json), and
//   • a fire-and-forget ping from the dashboard on load.
//
// It's idempotent: it only triggers a sync when an active creator is missing
// today's snapshot, throttles repeat triggers, and re-runs the SAME orchestrator
// (/api/sync), whose upserts make a re-run harmless. If the nightly run already
// succeeded, this is a couple of cheap reads and a no-op.

export async function GET(req: Request) {
  const db = createServerClient();

  // Auth: the cron (CRON_SECRET) OR any logged-in user (the dashboard nudge).
  const isCron = req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!isCron) {
    const ctx = await getAuthContext(req);
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = businessDate();

  // Active creators + which (creator, platform) snapshots already landed today.
  // A creator is only "done" once EVERY platform they have a handle for has a
  // snapshot today — checked per-platform, not "at least one row somewhere".
  const [creatorsRes, todaysRes] = await Promise.all([
    db.from("creators").select("id, instagram_username, tiktok_username").eq("active", true),
    db.from("view_snapshots").select("creator_id, platform").eq("snapshot_date", today),
  ]);
  if (creatorsRes.error) {
    return NextResponse.json({ error: creatorsRes.error.message }, { status: 500 });
  }
  const haveToday = new Set(
    (todaysRes.data ?? []).map(r => `${r.creator_id}:${r.platform}`)
  );
  // The fix: a creator with fresh TikTok but a rate-limited (stale) Instagram
  // used to count as "synced" and get skipped by the safety net, so the stale
  // number could sit for days. Now per-platform staleness triggers a heal too —
  // not just a whole-run miss (which still shows up here as everyone incomplete).
  const missing = (creatorsRes.data ?? []).filter(c => {
    const needsIg = !!c.instagram_username && !haveToday.has(`${c.id}:instagram`);
    const needsTt = !!c.tiktok_username && !haveToday.has(`${c.id}:tiktok`);
    return needsIg || needsTt;
  }).length;

  if (missing === 0) {
    return NextResponse.json({ action: "noop", today, missing: 0 });
  }

  // Advisory lock: bail if we triggered a catch-up recently.
  const { data: lockRow } = await db
    .from("app_settings")
    .select("value")
    .eq("key", LOCK_KEY)
    .maybeSingle();
  let lastAt = 0;
  try { lastAt = lockRow?.value ? Number(JSON.parse(lockRow.value).at) : 0; } catch { lastAt = 0; }
  const nowMs = Date.now();
  if (lastAt && nowMs - lastAt < THROTTLE_MS) {
    return NextResponse.json({ action: "throttled", today, missing, since_ms: nowMs - lastAt });
  }

  const baseUrl = resolveSyncBaseUrl();
  const secret = process.env.CRON_SECRET;
  if (!baseUrl || !secret) {
    return NextResponse.json(
      { action: "blocked", today, missing, error: "Missing SYNC_BASE_URL/CRON_SECRET — cannot self-trigger" },
      { status: 500 }
    );
  }

  // Take the lock BEFORE the long run so concurrent callers see it and bail.
  await db.from("app_settings").upsert(
    { key: LOCK_KEY, value: JSON.stringify({ at: nowMs, date: today }), updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );

  // Run the real sync by self-calling the SAME orchestrator the nightly cron uses,
  // so behaviour + upsert-idempotency match exactly. We await it: neither caller
  // (the backup cron, or the dashboard's fire-and-forget ping) needs a fast reply,
  // and once /api/sync is invoked it runs to completion on its own regardless.
  try {
    console.log(`[catchup] ${missing} creator(s) missing ${today} — running /api/sync`);
    const res = await fetch(`${baseUrl}/api/sync`, { headers: { authorization: `Bearer ${secret}` } });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json({ action: "triggered", today, missing, sync_status: res.status, sync: body });
  } catch (e) {
    console.error("[catchup] trigger failed:", e);
    return NextResponse.json({ action: "trigger_failed", today, missing, error: String(e) }, { status: 502 });
  }
}

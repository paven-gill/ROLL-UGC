import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAuth, allowedCreatorIds, scopeToCreators, isAuthError } from "@/lib/auth";
import { businessDate, addDays } from "@/lib/date";

// GET /api/dashboard/tracking-health
//
// Flags creators whose view tracking has silently frozen. Signal is snapshot
// freshness (not captured errors), so it catches ANY cause of a stall — a
// provider 500, a renamed handle, a rate-limit — regardless of whether an error
// was recorded. A platform is "stale" when its newest snapshot is older than
// STALE_DAYS. Only ACTIVE creators are checked (paused/finished are expected to
// stop), and only for platforms they actually have a handle for.

const STALE_DAYS = 2; // Instagram is nightly: synced today or yesterday = healthy; 2+ days = a real miss.

// TikTok syncs FORTNIGHTLY (see src/app/api/sync/route.ts), so a 2-day yardstick
// would false-flag it as stale for ~12 of every 14 days. Judge TikTok against its
// OWN cadence instead: it's only genuinely overdue once it's a grace period past a
// full cycle. Between scheduled syncs it's on-track, not an error — the response
// carries a neutral `tiktok_schedule` so the UI can show "next sync in Nd".
const TIKTOK_SYNC_EVERY_DAYS = Number(process.env.TIKTOK_SYNC_EVERY_DAYS) || 14;
const TIKTOK_GRACE_DAYS = 2; // allow a late run before calling it a real miss
const TIKTOK_STALE_DAYS =
  TIKTOK_SYNC_EVERY_DAYS <= 1 ? STALE_DAYS : TIKTOK_SYNC_EVERY_DAYS + TIKTOK_GRACE_DAYS;

// Is `dateStr` (YYYY-MM-DD) a scheduled TikTok sync day? Mirrors isTikTokSyncDay()
// in the sync route: runs on business days-of-month 1, 1+N, 1+2N, …
const isTikTokSyncDay = (dateStr: string) =>
  TIKTOK_SYNC_EVERY_DAYS <= 1 || Number(dateStr.slice(-2)) % TIKTOK_SYNC_EVERY_DAYS === 1;

export async function GET(req: Request) {
  try {
    const ctx = await requireAuth(req);
    const db = createServerClient();
    const ids = await allowedCreatorIds(db, ctx);
    const today = businessDate();
    // Bounded window keeps the read well under Supabase's 1000-row cap while still
    // covering any recent snapshot; a platform with nothing in here is "very stale".
    const lower = addDays(today, -45);

    const creatorsQ = db
      .from("creators")
      .select("id, name, instagram_username, tiktok_username, status, active")
      .order("name");

    const [{ data: creators }, { data: snaps }] = await Promise.all([
      ids === null ? creatorsQ : creatorsQ.in("id", ids),
      scopeToCreators(
        db
          .from("view_snapshots")
          .select("creator_id, platform, snapshot_date")
          .gte("snapshot_date", lower)
          .order("snapshot_date", { ascending: false }),
        ids,
      ),
    ]);

    // Newest snapshot date per creator+platform (rows are date-descending).
    const latest = new Map<string, string>();
    for (const s of snaps ?? []) {
      const k = `${s.creator_id}|${s.platform}`;
      if (!latest.has(k)) latest.set(k, s.snapshot_date as string);
    }
    const daysSince = (d: string | undefined) =>
      d ? Math.round((new Date(today).getTime() - new Date(d).getTime()) / 86400000) : null;

    type Issue = {
      creator_id: string;
      creator_name: string;
      platform: "instagram" | "tiktok";
      handle: string;
      last_snapshot: string | null;
      days_stale: number | null; // null = no snapshot at all in the window
    };
    const issues: Issue[] = [];

    for (const c of creators ?? []) {
      if (c.active === false || c.status === "paused" || c.status === "finished") continue;
      for (const platform of ["instagram", "tiktok"] as const) {
        const handle = platform === "instagram" ? c.instagram_username : c.tiktok_username;
        if (!handle) continue;
        const last = latest.get(`${c.id}|${platform}`);
        const age = daysSince(last);
        // Instagram: strict 2-day threshold. TikTok: only flag once it's genuinely
        // overdue past its fortnightly cadence — on-cadence gaps aren't errors.
        const threshold = platform === "instagram" ? STALE_DAYS : TIKTOK_STALE_DAYS;
        if (age === null || age >= threshold) {
          issues.push({
            creator_id: c.id as string,
            creator_name: c.name as string,
            platform,
            handle: handle as string,
            last_snapshot: last ?? null,
            days_stale: age,
          });
        }
      }
    }

    // Worst (most stale / never) first.
    issues.sort((a, b) => (b.days_stale ?? 99999) - (a.days_stale ?? 99999));

    // TikTok cadence status — a neutral "next scheduled sync" the UI shows in place
    // of a stale warning while TikTok is on-track between fortnightly runs.
    let lastTikTokSync: string | null = null;
    latest.forEach((d, k) => {
      if (k.endsWith("|tiktok") && (!lastTikTokSync || d > lastTikTokSync)) lastTikTokSync = d;
    });
    // Days until the next scheduled TikTok day. Count today as due (0) only if it's
    // a sync day that hasn't run yet; otherwise look forward to the next one.
    let nextTikTokSyncInDays: number | null = null;
    const startK = isTikTokSyncDay(today) && lastTikTokSync !== today ? 0 : 1;
    for (let k = startK; k <= 40; k++) {
      if (isTikTokSyncDay(addDays(today, k))) { nextTikTokSyncInDays = k; break; }
    }
    const tiktok_schedule = {
      cadence_days: TIKTOK_SYNC_EVERY_DAYS,
      last_synced: lastTikTokSync,
      next_sync_in_days: nextTikTokSyncInDays,
    };

    return NextResponse.json({ issues, tiktok_schedule, checked_at: today, stale_days: STALE_DAYS });
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

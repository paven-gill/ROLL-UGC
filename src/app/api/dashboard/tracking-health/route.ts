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

const STALE_DAYS = 2; // healthy = synced today or yesterday; 2+ days behind = a real miss

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
        if (age === null || age >= STALE_DAYS) {
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

    return NextResponse.json({ issues, checked_at: today, stale_days: STALE_DAYS });
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

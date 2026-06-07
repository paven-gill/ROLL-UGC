import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import {
  getWiseToken, fetchWiseProfiles, pickWiseProfile, fetchWiseActivities, matchPayout,
  type WiseActivity,
} from "@/lib/wise";

export async function GET() {
  const db = createServerClient();

  const { data, error } = await db
    .from("payout_cycles")
    .select(`
      id,
      cycle_start_date,
      cycle_end_date,
      payout_amount,
      base_fee,
      view_bonus,
      bonus_amount,
      bonus_note,
      views_earned,
      status,
      paid_at,
      created_at,
      creators (
        name,
        instagram_username,
        tiktok_username
      )
    `)
    .eq("status", "paid")
    .order("cycle_end_date", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const cycles = data ?? [];

  // Live reconciliation: pull real Wise transfers and match each payout by
  // recipient name + amount. Best-effort — if Wise is unreachable we still
  // return the payouts, just without a match.
  let activities: WiseActivity[] = [];
  try {
    const token = await getWiseToken();
    if (token) {
      const profiles = await fetchWiseProfiles(token);
      const profile = pickWiseProfile(profiles);
      if (profile) activities = await fetchWiseActivities(token, profile.id, 60);
    }
  } catch {}

  const enriched = cycles.map((c: any) => {
    const name = c.creators?.name ?? "";
    const wise = activities.length ? matchPayout(name, c.payout_amount, activities) : null;
    return { ...c, wise };
  });

  return NextResponse.json(enriched);
}

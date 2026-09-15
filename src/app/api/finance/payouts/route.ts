import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAuth, allowedCreatorIds, scopeToCreators, isAuthError } from "@/lib/auth";

// Payout history — every cycle marked paid in the dashboard. Payments themselves
// happen in Trybe, so there's no bank reconciliation here: this is the record of
// what was owed, what was paid, and when.
export async function GET(req: Request) {
  try {
  const ctx = await requireAuth(req);
  const db = createServerClient();
  const ids = await allowedCreatorIds(db, ctx);

  const { data, error } = await scopeToCreators(db
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
        tiktok_username,
        campaigns ( name )
      )
    `)
    .eq("status", "paid")
    .order("cycle_end_date", { ascending: false })
    .limit(50), ids);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

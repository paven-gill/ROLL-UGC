import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

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
      views_earned,
      status,
      created_at,
      creators (
        name,
        instagram_username,
        tiktok_username
      )
    `)
    .eq("status", "paid")
    .order("cycle_end_date", { ascending: false })
    .limit(20);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}

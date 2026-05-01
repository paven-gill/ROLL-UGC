import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export async function GET() {
  const db = createServerClient();

  const [{ data: creators, error }, { data: metrics }, { data: payouts }] = await Promise.all([
    db.from("creators").select("*").order("name"),
    db.from("monthly_metrics").select("*").order("year", { ascending: false }).order("month", { ascending: false }),
    db.from("payout_cycles").select("creator_id, payout_amount, views_earned, status"),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const metricsByCreator = new Map<string, typeof metrics>();
  for (const m of metrics ?? []) {
    if (!metricsByCreator.has(m.creator_id)) metricsByCreator.set(m.creator_id, []);
    metricsByCreator.get(m.creator_id)!.push(m);
  }

  // Sum closed cycle payouts per creator (exclude in_progress rows)
  const payoutsByCreator = new Map<string, { completed_payout_total: number; completed_views_total: number }>();
  for (const p of payouts ?? []) {
    if (p.status === "in_progress") continue;
    const existing = payoutsByCreator.get(p.creator_id) ?? { completed_payout_total: 0, completed_views_total: 0 };
    existing.completed_payout_total += p.payout_amount ?? 0;
    existing.completed_views_total  += p.views_earned  ?? 0;
    payoutsByCreator.set(p.creator_id, existing);
  }

  const result = (creators ?? []).map(c => ({
    ...c,
    metrics: metricsByCreator.get(c.id) ?? [],
    completed_payout_total: payoutsByCreator.get(c.id)?.completed_payout_total ?? 0,
    completed_views_total:  payoutsByCreator.get(c.id)?.completed_views_total  ?? 0,
  }));
  return NextResponse.json(result);
}

export async function POST(req: Request) {
  const db = createServerClient();
  const body = await req.json();

  const { data, error } = await db
    .from("creators")
    .insert({
      name: body.name,
      instagram_username: body.instagram_username || null,
      tiktok_username: body.tiktok_username || null,
      base_fee: body.base_fee || 0,
      rate_per_thousand_views: body.rate_per_thousand_views || 2.0,
      affiliate_percentage: body.affiliate_percentage || 0,
      monthly_target: body.monthly_target || 30,
      joined_at: body.joined_at || new Date().toISOString().split("T")[0],
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

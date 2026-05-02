import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

// GET /api/dashboard/payout-events?from=YYYY-MM-DD&to=YYYY-MM-DD[&creator_id=uuid]
//
// Returns completed payout cycles whose cycle_end_date falls in [from, to].
// Used by the home chart to render payout dot markers on cycle completion dates.

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const creatorId = searchParams.get("creator_id") ?? null;

  if (!from || !to) {
    return NextResponse.json({ error: "Provide from and to dates" }, { status: 400 });
  }

  const db = createServerClient();

  let q = db
    .from("payout_cycles")
    .select("creator_id, cycle_start_date, cycle_end_date, base_fee, creators(name)")
    .gte("cycle_end_date", from)
    .lte("cycle_end_date", to)
    .in("status", ["pending", "paid"])
    .order("cycle_end_date");

  if (creatorId) q = q.eq("creator_id", creatorId);

  const { data } = await q;

  const events = (data ?? []).map(c => {
    const cr = (c.creators as unknown) as { name: string } | null;
    return {
      date: c.cycle_end_date as string,
      creator_name: cr?.name ?? "Unknown",
      cycle_start_date: c.cycle_start_date as string,
      cycle_end_date: c.cycle_end_date as string,
      base_fee: c.base_fee as number,
    };
  });

  return NextResponse.json(events);
}

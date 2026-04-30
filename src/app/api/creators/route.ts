import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export async function GET() {
  const db = createServerClient();
  const { data, error } = await db
    .from("creators")
    .select("*")
    .order("name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
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

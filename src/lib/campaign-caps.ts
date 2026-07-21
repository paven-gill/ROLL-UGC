import { createServerClient } from "@/lib/supabase";

// Per-campaign payout view cap (campaigns.monthly_view_cap). null = uncapped.
//
// Loading is DEFENSIVE on purpose: the `monthly_view_cap` column is added by a
// migration that must be run in the DB separately. If the column doesn't exist
// yet (or the query fails for any reason) we fall back to "no cap for anyone",
// which is exactly today's behaviour — so the app is safe to deploy before the
// migration lands, and simply starts enforcing caps once the column is present.

export async function loadCampaignViewCaps(
  db: ReturnType<typeof createServerClient>
): Promise<Map<string, number | null>> {
  const caps = new Map<string, number | null>();
  try {
    const { data, error } = await db.from("campaigns").select("id, monthly_view_cap");
    if (error) return caps; // column missing / query failed → uncapped
    for (const c of data ?? []) {
      caps.set(c.id as string, (c.monthly_view_cap as number | null) ?? null);
    }
  } catch {
    // swallow — uncapped fallback
  }
  return caps;
}

// Cap for a single campaign. Returns null (uncapped) if unknown or unavailable.
export async function getCampaignViewCap(
  db: ReturnType<typeof createServerClient>,
  campaignId: string | null | undefined
): Promise<number | null> {
  if (!campaignId) return null;
  try {
    const { data, error } = await db
      .from("campaigns")
      .select("monthly_view_cap")
      .eq("id", campaignId)
      .single();
    if (error) return null;
    return (data?.monthly_view_cap as number | null) ?? null;
  } catch {
    return null;
  }
}

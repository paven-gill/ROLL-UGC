import { NextResponse } from "next/server";
import { getWiseConfig, fetchWiseProfiles, pickWiseProfile, fetchWiseActivities } from "@/lib/wise";
import { requireAuth, isAuthError } from "@/lib/auth";

// GET /api/wise/transactions — recent real transfers from this campaign's Wise account.
export async function GET(req: Request) {
  try {
  const ctx = await requireAuth(req);
  if (!ctx.campaignId) return NextResponse.json({ error: "select_campaign" }, { status: 400 });
  const { token, profileId: storedProfileId } = await getWiseConfig(ctx.campaignId);
  if (!token) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  let profileId: number;
  try {
    const profiles = await fetchWiseProfiles(token);
    const profile = pickWiseProfile(profiles, storedProfileId);
    if (!profile) return NextResponse.json({ error: "no_profile" }, { status: 404 });
    profileId = profile.id;
  } catch (e: any) {
    if (e?.status === 401) return NextResponse.json({ error: "wise_auth_failed" }, { status: 401 });
    return NextResponse.json({ error: "wise_unreachable" }, { status: 502 });
  }

  try {
    const transactions = await fetchWiseActivities(token, profileId, 60);
    return NextResponse.json({ transactions });
  } catch {
    return NextResponse.json({ error: "wise_unreachable" }, { status: 502 });
  }
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}

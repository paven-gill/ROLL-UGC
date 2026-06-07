import { NextResponse } from "next/server";
import { getWiseToken, fetchWiseProfiles, pickWiseProfile, fetchWiseTransfers } from "@/lib/wise";

// GET /api/wise/transactions — recent real transfers from the Wise account.
export async function GET() {
  const token = await getWiseToken();
  if (!token) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  let profileId: number;
  try {
    const profiles = await fetchWiseProfiles(token);
    const profile = pickWiseProfile(profiles);
    if (!profile) return NextResponse.json({ error: "no_profile" }, { status: 404 });
    profileId = profile.id;
  } catch (e: any) {
    if (e?.status === 401) return NextResponse.json({ error: "wise_auth_failed" }, { status: 401 });
    return NextResponse.json({ error: "wise_unreachable" }, { status: 502 });
  }

  try {
    const transfers = await fetchWiseTransfers(token, profileId, 60);
    return NextResponse.json({ transfers });
  } catch {
    return NextResponse.json({ error: "wise_unreachable" }, { status: 502 });
  }
}

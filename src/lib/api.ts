// Client-side fetch wrapper that stamps the active campaign onto every /api call
// via the x-campaign-id header. The header is only honored server-side for
// super_admins; brand_admins are always locked to their own campaign, so it is
// safe that this value is set on the client.
//
// The active campaign is held at module level and kept in sync by AuthProvider
// (setApiCampaign), so existing fetch call sites only need fetch -> apiFetch.

let _activeCampaignId: string | null = null;

export function setApiCampaign(id: string | null) {
  _activeCampaignId = id;
}

export function apiFetch(input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-campaign-id", _activeCampaignId ?? "all");
  return fetch(input, { ...init, headers });
}

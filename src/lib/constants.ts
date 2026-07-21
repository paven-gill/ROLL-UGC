// Per-video lifetime view cap for PAYOUT purposes.
//
// A single video's views count toward a creator's payout only up to this many
// views. Beyond it, extra views still show on the dashboard (true totals are
// never capped) but do not increase the payout — i.e. views and payments cap
// per video. Applied as sum(min(post_views, CAP)) across a creator's posts.
export const PER_VIDEO_VIEW_CAP = 1_000_000;

// Per-CYCLE cap on a creator's COMBINED payable (capped) views across all their
// videos in the 30-day cycle. Configured per campaign (campaigns.monthly_view_cap;
// null = uncapped). This is a hard ceiling on the payout: the view bonus is
// min(capped_views_earned, cap) / 1000 * rate — e.g. a 1,000,000 cap at a $1 CPM
// tops the view bonus out at $1,000 no matter how many views are earned. The
// stored capped_views_earned stays the TRUE combined total (never lowered by the
// cap) so displays and post-exclusion math keep full information; the ceiling is
// applied only where the payout amount is computed.
export function applyCycleViewCap(cappedViewsEarned: number, cap: number | null | undefined): number {
  if (cap == null) return cappedViewsEarned;
  return Math.min(cappedViewsEarned, Math.max(0, cap));
}

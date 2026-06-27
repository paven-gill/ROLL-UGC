// Per-video lifetime view cap for PAYOUT purposes.
//
// A single video's views count toward a creator's payout only up to this many
// views. Beyond it, extra views still show on the dashboard (true totals are
// never capped) but do not increase the payout — i.e. views and payments cap
// per video. Applied as sum(min(post_views, CAP)) across a creator's posts.
export const PER_VIDEO_VIEW_CAP = 1_000_000;

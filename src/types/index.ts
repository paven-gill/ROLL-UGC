export interface Creator {
  id: string;
  name: string;
  instagram_username: string | null;
  tiktok_username: string | null;
  base_fee: number;
  rate_per_thousand_views: number;
  affiliate_percentage: number;
  monthly_target: number;
  active: boolean;
  joined_at: string; // "YYYY-MM-DD"
  created_at: string;
}

export interface MonthlyMetrics {
  id: string;
  creator_id: string;
  platform: "instagram" | "tiktok";
  year: number;
  month: number;
  total_views: number;
  post_count: number;
  follower_count: number;
  synced_at: string;
}

export interface CreatorWithMetrics extends Creator {
  metrics: MonthlyMetrics[];
}

export interface MonthlySummary {
  total_views: number;
  ig_views: number;
  tt_views: number;
  total_posts: number;
  ig_posts: number;
  tt_posts: number;
  ig_followers: number;
  tt_followers: number;
  estimated_payout: number;
  on_track: boolean;
}

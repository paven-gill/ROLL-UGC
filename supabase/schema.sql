-- UGC Creator Dashboard Schema
-- Run this in your Supabase SQL editor

CREATE TABLE creators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  instagram_username TEXT,
  tiktok_username TEXT,
  base_fee DECIMAL(10,2) DEFAULT 0,
  rate_per_thousand_views DECIMAL(10,4) DEFAULT 2.00,
  affiliate_percentage DECIMAL(5,2) DEFAULT 0,
  monthly_target INTEGER DEFAULT 30,
  active BOOLEAN DEFAULT true,
  joined_at DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ─── Daily tracking (analytics / debugging) ───────────────────────────────────
-- One row per creator+platform per day. cumulative_views = total eligible views
-- (posts >= joined_at) as of that scrape. Not used for payouts directly.

CREATE TABLE view_snapshots (
  creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'tiktok')),
  snapshot_date DATE NOT NULL,
  cumulative_views BIGINT NOT NULL DEFAULT 0,
  post_count_30d INTEGER DEFAULT 0,
  follower_count INTEGER DEFAULT 0,
  synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (creator_id, platform, snapshot_date)
);

-- ─── Rolling 30-day cycle state ───────────────────────────────────────────────
-- One row per creator. Tracks the ACTIVE cycle: start date, end date, and
-- the baseline views at the start of this cycle. Updated each time a cycle closes.

CREATE TABLE creator_cycles (
  creator_id UUID PRIMARY KEY REFERENCES creators(id) ON DELETE CASCADE,
  cycle_start_date DATE NOT NULL,         -- start of current cycle
  cycle_end_date DATE NOT NULL,           -- cycle_start_date + 30 days
  baseline_views BIGINT NOT NULL DEFAULT 0, -- total eligible views at cycle start
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ─── Completed payout cycles ──────────────────────────────────────────────────
-- One row per completed cycle per creator. Immutable once created.
-- Payout grouping: use cycle_end_date's month.

CREATE TABLE payout_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,
  cycle_start_date DATE NOT NULL,
  cycle_end_date DATE NOT NULL,
  start_views BIGINT NOT NULL,            -- baseline_views at cycle start
  end_views BIGINT NOT NULL,              -- total eligible views at cycle end
  views_earned BIGINT NOT NULL,           -- end_views - start_views
  base_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
  view_bonus DECIMAL(10,2) NOT NULL DEFAULT 0,
  payout_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(creator_id, cycle_start_date)
);

-- ─── Post-level snapshots (post grid UI) ──────────────────────────────────────

CREATE TABLE post_snapshots (
  post_id TEXT NOT NULL,
  creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'tiktok')),
  view_count_used BIGINT DEFAULT 0,
  view_field_used TEXT,
  like_count BIGINT DEFAULT 0,
  comment_count BIGINT DEFAULT 0,
  media_type TEXT,
  taken_at TIMESTAMP WITH TIME ZONE,
  thumbnail_url TEXT,
  synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (post_id, creator_id, platform)
);

-- ─── Analytics cache (optional, not used for payouts) ────────────────────────

CREATE TABLE monthly_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'tiktok')),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  total_views BIGINT DEFAULT 0,
  post_count INTEGER DEFAULT 0,
  follower_count INTEGER DEFAULT 0,
  synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(creator_id, platform, year, month)
);

-- ─── Security ─────────────────────────────────────────────────────────────────

ALTER TABLE creators ENABLE ROW LEVEL SECURITY;
ALTER TABLE view_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE creator_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON creators FOR ALL USING (true);
CREATE POLICY "service_role_all" ON view_snapshots FOR ALL USING (true);
CREATE POLICY "service_role_all" ON creator_cycles FOR ALL USING (true);
CREATE POLICY "service_role_all" ON payout_cycles FOR ALL USING (true);
CREATE POLICY "service_role_all" ON post_snapshots FOR ALL USING (true);
CREATE POLICY "service_role_all" ON monthly_metrics FOR ALL USING (true);

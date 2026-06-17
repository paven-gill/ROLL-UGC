-- 001_auth_campaigns.sql
-- Adds authentication + multi-campaign (multi-tenant) isolation.
-- Run this in the Supabase SQL editor AFTER schema.sql.
--
-- Model:
--   campaigns           — one row per brand/campaign (e.g. "Roll")
--   profiles            — links a Supabase auth.users row to a role + campaign
--   creators.campaign_id — every creator belongs to exactly one campaign;
--                          the 6 child tables inherit scope via creator_id.
--
-- Roles:
--   super_admin  — the owner; campaign_id NULL; sees ALL campaigns
--   brand_admin  — a client; campaign_id required; sees ONLY their campaign

-- ─── 1. Campaigns ─────────────────────────────────────────────────────────────
CREATE TABLE campaigns (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  slug       TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 2. Profiles (auth user -> role + campaign) ──────────────────────────────
CREATE TABLE profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT,
  role        TEXT NOT NULL DEFAULT 'brand_admin'
              CHECK (role IN ('super_admin', 'brand_admin')),
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_profiles_campaign ON profiles(campaign_id);

-- ─── 3. Scope creators to a campaign ─────────────────────────────────────────
ALTER TABLE creators ADD COLUMN campaign_id UUID REFERENCES campaigns(id);

-- ─── 4. Backfill: create "Roll" and assign all existing creators ─────────────
INSERT INTO campaigns (name, slug) VALUES ('Roll', 'roll');
UPDATE creators
  SET campaign_id = (SELECT id FROM campaigns WHERE slug = 'roll')
  WHERE campaign_id IS NULL;

-- ─── 5. Enforce + index after backfill ───────────────────────────────────────
ALTER TABLE creators ALTER COLUMN campaign_id SET NOT NULL;
CREATE INDEX idx_creators_campaign ON creators(campaign_id);

-- ─── 6. RLS (defense-in-depth; service role bypasses these) ──────────────────
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles  ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON campaigns FOR ALL USING (true);
CREATE POLICY "service_role_all" ON profiles  FOR ALL USING (true);
-- A logged-in user may read only their own profile (via the session/anon client):
CREATE POLICY "self_read" ON profiles FOR SELECT USING (auth.uid() = id);

-- ─── 7. Seed the owner's profile ─────────────────────────────────────────────
-- After creating your own user in Supabase Auth (Authentication → Users),
-- find its id and run (replace the UUID + email):
--
--   INSERT INTO profiles (id, email, role, campaign_id)
--   VALUES ('<your-auth-user-id>', 'paven@futurecreator.biz', 'super_admin', NULL);
--
-- Brand admins are created in-app via the Manage Users screen once scoping is live.

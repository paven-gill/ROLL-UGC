// ─── TikTok scraper selector ──────────────────────────────────────────────────
//
// Single switch point between the legacy Apify scraper and the new ScrapTik one.
// Routes import scrapeTikTok / scrapeTikTokBatch from HERE (not from apify.ts),
// so flipping the provider is one env var with zero code changes:
//
//   TIKTOK_SCRAPER=scraptik   → ScrapTik (RapidAPI)
//   TIKTOK_SCRAPER=apify       → Apify (legacy)         [default while testing]
//
// Defaults to "apify" so nothing changes until you explicitly opt in. Once the
// side-by-side test (/api/sync/tiktok/test) confirms ScrapTik's numbers line up,
// set TIKTOK_SCRAPER=scraptik in Vercel and the whole app uses it.

import {
  scrapeTikTok as scrapeTikTokApify,
  scrapeTikTokBatch as scrapeTikTokBatchApify,
  type TikTokTarget,
  type ScrapedData,
} from "./apify";
import { scrapeTikTokScraptik, scrapeTikTokScraptikBatch } from "./scraptik";

export type { TikTokTarget, ScrapedData };

function useScraptik(): boolean {
  return (process.env.TIKTOK_SCRAPER ?? "apify").trim().toLowerCase() === "scraptik";
}

export function scrapeTikTok(username: string, joinedAt?: string | null): Promise<ScrapedData> {
  return useScraptik() ? scrapeTikTokScraptik(username, joinedAt) : scrapeTikTokApify(username, joinedAt);
}

export function scrapeTikTokBatch(targets: TikTokTarget[]): Promise<Map<string, ScrapedData>> {
  return useScraptik() ? scrapeTikTokScraptikBatch(targets) : scrapeTikTokBatchApify(targets);
}

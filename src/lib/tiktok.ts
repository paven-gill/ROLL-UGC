// ─── TikTok scraper selector ──────────────────────────────────────────────────
//
// Single switch point between the legacy Apify scraper and the new ScrapTik one.
// Routes import scrapeTikTok / scrapeTikTokBatch from HERE (not from apify.ts),
// so flipping the provider is one env var with zero code changes:
//
//   TIKTOK_SCRAPER=scraptik   → ScrapTik (RapidAPI)     [default]
//   TIKTOK_SCRAPER=apify       → Apify (legacy)          [emergency escape hatch]
//
// The migration is complete: ScrapTik is now the default, so production uses it
// even if the env var is unset (no silent fallback to Apify). Apify stays wired
// up only as a break-glass fallback — set TIKTOK_SCRAPER=apify to revert.

import {
  scrapeTikTok as scrapeTikTokApify,
  scrapeTikTokBatch as scrapeTikTokBatchApify,
  type TikTokTarget,
  type ScrapedData,
} from "./apify";
import { scrapeTikTokScraptik, scrapeTikTokScraptikBatch } from "./scraptik";

export type { TikTokTarget, ScrapedData };

function useScraptik(): boolean {
  // Default to ScrapTik; only the explicit opt-out "apify" reverts to the legacy
  // scraper. Any other value (including unset/typo) stays on ScrapTik.
  return (process.env.TIKTOK_SCRAPER ?? "scraptik").trim().toLowerCase() !== "apify";
}

export function scrapeTikTok(username: string, joinedAt?: string | null): Promise<ScrapedData> {
  return useScraptik() ? scrapeTikTokScraptik(username, joinedAt) : scrapeTikTokApify(username, joinedAt);
}

export function scrapeTikTokBatch(targets: TikTokTarget[]): Promise<Map<string, ScrapedData>> {
  return useScraptik() ? scrapeTikTokScraptikBatch(targets) : scrapeTikTokBatchApify(targets);
}

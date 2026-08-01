// ─── TikTok scraper selector ──────────────────────────────────────────────────
//
// Single switch point between the TikTok scraper providers. Routes import
// scrapeTikTok / scrapeTikTokBatch from HERE (not from a provider module), so
// flipping the provider is one env var with zero code changes:
//
//   TIKTOK_SCRAPER=scraptik   → ScrapTik (RapidAPI)     [default]
//   TIKTOK_SCRAPER=tikwm       → tikwm / tiktok-scraper7 (RapidAPI, cheap/free)
//   TIKTOK_SCRAPER=apify       → Apify (legacy)          [emergency escape hatch]
//
// Unset/typo falls through to ScrapTik (no silent change). All three return the
// identical ScrapedData shape, so nothing downstream cares which one runs.

import {
  scrapeTikTok as scrapeTikTokApify,
  scrapeTikTokBatch as scrapeTikTokBatchApify,
  type TikTokTarget,
  type ScrapedData,
} from "./apify";
import { scrapeTikTokScraptik, scrapeTikTokScraptikBatch } from "./scraptik";
import { scrapeTikTokTikwm, scrapeTikTokTikwmBatch } from "./tikwm";

export type { TikTokTarget, ScrapedData };

type Provider = "scraptik" | "tikwm" | "apify";

function provider(): Provider {
  const v = (process.env.TIKTOK_SCRAPER ?? "scraptik").trim().toLowerCase();
  if (v === "tikwm") return "tikwm";
  if (v === "apify") return "apify";
  return "scraptik"; // default / unset / typo
}

export function scrapeTikTok(username: string, joinedAt?: string | null): Promise<ScrapedData> {
  switch (provider()) {
    case "tikwm": return scrapeTikTokTikwm(username, joinedAt);
    case "apify": return scrapeTikTokApify(username, joinedAt);
    default:      return scrapeTikTokScraptik(username, joinedAt);
  }
}

export function scrapeTikTokBatch(targets: TikTokTarget[]): Promise<Map<string, ScrapedData>> {
  switch (provider()) {
    case "tikwm": return scrapeTikTokTikwmBatch(targets);
    case "apify": return scrapeTikTokBatchApify(targets);
    default:      return scrapeTikTokScraptikBatch(targets);
  }
}

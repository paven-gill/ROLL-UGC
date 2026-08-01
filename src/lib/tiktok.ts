// ─── TikTok scraper selector ──────────────────────────────────────────────────
//
// Single switch point between the TikTok scraper providers. Routes import
// scrapeTikTok / scrapeTikTokBatch from HERE (not from a provider module), so
// flipping the provider is one env var with zero code changes:
//
//   TIKTOK_SCRAPER=tikwm       → tikwm / tiktok-scraper7 (RapidAPI, free)  [default]
//   TIKTOK_SCRAPER=scraptik   → ScrapTik (RapidAPI)     [cancelled — will 403]
//   TIKTOK_SCRAPER=apify       → Apify (legacy)          [emergency escape hatch]
//
// Default is tikwm: ScrapTik's paid subscription was cancelled (2026-08), so it
// now 403s and must NOT be the fallback. Unset/typo → tikwm. All providers return
// the identical ScrapedData shape, so nothing downstream cares which one runs.

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
  const v = (process.env.TIKTOK_SCRAPER ?? "tikwm").trim().toLowerCase();
  if (v === "apify") return "apify";
  // ScrapTik is DECOMMISSIONED — its subscription was cancelled (2026-08) and it
  // now 403s. Ignore any lingering TIKTOK_SCRAPER=scraptik (a stale prod env var
  // was still forcing ScrapTik after the switch) and route everything else to tikwm.
  if (v === "scraptik") {
    console.warn("[tiktok] TIKTOK_SCRAPER=scraptik ignored — ScrapTik decommissioned; using tikwm");
  }
  return "tikwm";
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

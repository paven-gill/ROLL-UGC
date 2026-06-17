// ─── Business-day dating ──────────────────────────────────────────────────────
// Single source of truth for the dashboard's "today". Every snapshot date, cycle
// boundary and chart window is computed in THIS timezone — not UTC — so a sync
// that runs in the Australian morning is filed under that Australian calendar day.
//
// Why this exists: the nightly cron fires at 23:55 UTC, which is ~09:55 in this
// zone. With UTC dating, 23:55 UTC still reads as the PREVIOUS calendar day, so a
// morning sync got stamped a day behind and "today" never appeared on the board.
//
// Change BUSINESS_TZ if the business relocates. "Australia/Sydney" is the eastern
// zone and is DST-aware (AEST in winter, AEDT in summer); use "Australia/Brisbane"
// for a fixed UTC+10 with no daylight saving.
export const BUSINESS_TZ = "Australia/Sydney";

// YYYY-MM-DD for the given instant in the business timezone (defaults to now).
export function businessDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// Day-of-month (1–31) for the given instant in the business timezone. Derived
// from businessDate() so it shares the same "today" as everything else on the
// board — the day a sync is filed under, not the UTC day.
export function businessDayOfMonth(d: Date = new Date()): number {
  return Number(businessDate(d).slice(-2));
}

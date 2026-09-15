# UGC Creator Dashboard Scope

## Purpose

The dashboard exists to track organic creator content across Instagram and TikTok, and to work out what each creator is owed for a given cycle.

Its single most important output is **cost per thousand views (CPM)** — what the business is actually paying for organic reach. Everything else (posts, views, cycles, payout amounts) exists to make that number trustworthy.

The dashboard **does not send money.** Payments are made as bonuses in **Trybe** (jointrybe.com). The dashboard records that a payout happened: the amount, the date, and an optional Trybe reference.

## Primary Users

The business operator managing UGC creators, plus per-brand managers.

Two roles:

- **super_admin (owner)** — sees every campaign, can switch between brands or view "All campaigns" as a portfolio. Manages campaigns and users.
- **brand_admin (manager)** — permanently locked to one campaign. The campaign header is never trusted from the client for this role.

Creators are not users of the dashboard.

## Multi-Brand Model

Every creator belongs to a **campaign** (a brand). All data is scoped by campaign via the `x-campaign-id` header, which only a super_admin may set.

"All campaigns" is a portfolio view: Home and Finance work across every brand; Creators and Payouts require a specific campaign to be selected.

## Dashboard Areas

### Home

The daily operating view — "how are creators performing right now?"

- total views, total payouts, CPM, total posts
- Instagram-only / TikTok-only platform filters
- a toggle to fold base retainers into the payout total (combined view only — retainers aren't tied to a platform)
- creator filter and range picker (7 / 14 / 30 days, a specific month, or all time)
- Views Over Time chart, with a dot marking each completed cycle
- top posts (top 8 for a single creator, top 4 per creator across the roster)
- a tracking-health badge flagging creators whose view tracking has silently frozen
- a self-healing catch-up that re-runs the nightly sync if it was missed

### Creators

The roster — "who is in the program, what is their deal, are they active?"

- list, search, and sort creators; toggle between active and paused/finished
- deal terms shown as base fee per month and rate per 1,000 views
- add a creator, quick-edit, manually sync one creator, open their detail page

### Creator Detail

The full record for one creator.

- all-time views, all-time posts, total paid out
- edit payment terms (base fee, rate per 1K), social handles, and program details (name, monthly post target, join date)
- pause, reactivate, finish, or delete
- cycle history, with editable cycle dates
- every synced post, with the ability to exclude posts from counting

### Payouts

Cycle-by-cycle amounts owed, filtered to cycles ending in a chosen month.

- creator, cycle period, posts vs target, views earned, base fee, view bonus, total
- status: In Progress, Pending, or Paid
- a **Pay** button on a finished cycle opens the record-payout modal

### Finance

The payout record — every cycle marked paid, and when.

- creator, cycle period, paid date, views, amount
- click any row for the base fee / view bonus / discretionary bonus breakdown
- month filter, totals row, CSV export
- in "All campaigns", an extra Brand column; otherwise the layout is identical

There is no bank integration and no balance. Money moves in Trybe.

## Data Model

### Creators

name, Instagram username, TikTok username, base monthly fee, rate per 1,000 views, monthly post target, joined date, status (active / paused / finished), campaign.

`affiliate_percentage`, `wise_email`, and `wise_tag` still exist as columns but are **legacy** — unused by the app, kept so historical values aren't lost.

### Post Snapshots

Per-post evidence: creator, platform, post ID, media type, post date, views used, which field the views came from, likes, comments, thumbnail, sync time.

### View Snapshots

Daily platform-level cumulative records: creator, platform, snapshot date, cumulative views, **capped** cumulative views (the payable basis), recent post count, follower count, sync time.

Note: Supabase caps reads at 1,000 rows by default. This table grows roughly one row per creator per platform per day, so any query against it must bound by date and page — otherwise it silently drops the newest rows.

### Creator Cycles / Payout Cycles

- `creator_cycles` — exactly one row per creator: the cycle currently running, with its view baselines.
- `payout_cycles` — the permanent, stamped history. One row per completed cycle, with the frozen numbers, status (`pending` / `paid`), `paid_at`, any discretionary bonus and note, and `tribe_reference`.

Once a cycle is stamped it is never recomputed. That's what makes the payment record durable.

## Data Collection

- **Instagram** — RapidAPI (Looter2), synced nightly.
- **TikTok** — RapidAPI (tikwm / tiktok-scraper7), synced **fortnightly by default** (`TIKTOK_SYNC_EVERY_DAYS=14`). This cadence is deliberate: the free tier allows only 300 requests per month, and daily syncing blows through it in days, after which every call fails and TikTok silently records zero views.

The sync process: find the creator → scrape their connected platforms → store a daily view snapshot → store or refresh post snapshots → update monthly metrics → run cycle rollover.

Syncing happens through the nightly cron for all active creators, or manually for one creator.

## Cycle And Payout Logic

Cycles are **rolling 30 days per creator**, anchored to their join date — not calendar months.

After every sync, cycle rollover runs:

- no cycle yet → onboard, creating the first cycle from the join date
- cycle still running → report progress, change nothing
- cycle term over → stamp the finished cycle as a `pending` payout and immediately open the next cycle from a fresh baseline

Paused and finished creators are skipped entirely: no new cycles, no payout estimates. Their already-stamped payout history is never touched.

The payout is:

```text
payout = base fee + (payable views / 1,000 * rate per 1,000 views)
```

Two caps limit **payable** views. Neither ever reduces displayed view counts — true totals are always shown in full.

1. **Per video** — a single video contributes at most 1,000,000 views toward payout.
2. **Per cycle, per campaign** — `campaigns.monthly_view_cap` is a hard ceiling on combined payable views in one cycle. Roll is capped at 1,000,000; other campaigns are uncapped by default.

## Payment Flow

1. A cycle ends and is stamped `pending`.
2. On the Payouts tab, click **Pay**.
3. The modal shows the base fee, view bonus, and an optional discretionary bonus, plus the total.
4. Set the **paid date** (defaults to today) and optionally a **Trybe reference**.
5. Click **Open Trybe & mark as paid** — the payout is recorded here and Trybe opens in a new tab.
6. Send the bonus in Trybe for the amount shown.

The dashboard is the record of what was owed and paid. Trybe is where the money actually moves.

## What The Dashboard Can Be Trusted For

- tracking creators and their deal terms
- syncing Instagram and TikTok performance
- CPM and cost-per-view analysis across any range
- reviewing posts and excluding ones that shouldn't count
- calculating what a creator is owed for a completed cycle
- a permanent record of what was paid and when

## Known Gaps

- `monthly_metrics` is an analytics cache derived from calendar-month snapshot deltas. Payouts do **not** use it — they use cycle baselines — but the two won't always agree, because cycles aren't calendar months.
- There's no audit trail of edits. Changing a cycle's dates or excluding a post changes the numbers with no record of who did it or when.
- Several `view_snapshots` queries are still unbounded (the all-time chart, the creators list, per-creator cycles). They sort newest-first so they currently return fresh data, but they should be paged as the table grows.

## Possible Future Scope

- export a per-creator payout statement, not just the payouts CSV
- an approval step between `pending` and `paid`
- an audit trail for manual adjustments
- review tooling for edge cases: creator missed their post target, joined or paused mid-cycle, a platform failed to sync, a post was deleted, a suspicious view spike

## Out Of Scope

- a creator-facing portal
- invoice generation
- sending payments (this now lives in Trybe)
- a full CRM, content approval, or contract signing

## Product North Star

At the end of every cycle, the business should be able to open the dashboard, see exactly why a creator is owed a certain amount, pay it in Trybe, record it here, and know what that reach cost per thousand views.

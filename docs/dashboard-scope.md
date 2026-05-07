# UGC Creator Dashboard Scope

## Purpose

The UGC Creator Dashboard exists to help the business track creator activity, collect post performance data, and calculate creator payouts with enough confidence that monthly payments can be reviewed and paid accurately.

The dashboard is not just a performance dashboard. Its real job is to create a reliable monthly record of:

- who is in the creator program
- what their deal terms are
- what they posted
- how each post performed
- what they should be paid for a given month

## Primary Users

The primary user is the business operator managing UGC creators.

They need to:

- add and manage creators
- sync creator performance data
- see which creators are active or paused
- review posts and views
- compare creators
- estimate payouts
- prepare monthly payment decisions

Creators are not currently direct users of the dashboard.

## Current Dashboard Areas

### Home

The Home view gives a high-level performance overview across creators.

Current capabilities:

- view total views
- view estimated payout totals
- view cost per thousand views
- view total posts
- filter by creator
- filter by recent ranges such as 7, 14, or 30 days
- view specific months
- see views over time
- see top posts by creator

This area is best understood as the daily operating view. It answers, "How are creators performing right now?"

### Creators

The Creators view is the roster and management area.

Current capabilities:

- list all creators
- add a creator
- view creator status
- view creator deal terms
- sort creators by posts, views, payout, join date, or status
- quick-edit creator details
- manually sync an individual creator
- open a creator detail page

This area answers, "Who is in the program, what is their deal, and are they active?"

### Creator Detail

The creator detail page is the individual record for one creator.

Current capabilities:

- view creator profile information
- edit payment terms
- edit social handles
- edit program details
- pause, reactivate, or delete a creator
- sync the creator
- review all-time stats
- review monthly history
- review posts synced for that creator

This area answers, "What is the full record for this creator?"

### Payouts

The Payouts view estimates what creators should be paid.

Current capabilities:

- choose a time range
- view Instagram views
- view TikTok views
- view total views
- view CPM
- view base fee
- view view bonus
- view total estimated payout
- sort payout rows
- view grand totals

This area answers, "What should I expect to pay creators for this period?"

## Data Model

### Creators

Creators are the people in the UGC program.

Important fields:

- name
- Instagram username
- TikTok username
- base monthly fee
- rate per 1,000 views
- affiliate percentage
- monthly target
- joined date
- active status

### Post Snapshots

Post snapshots are the evidence of individual content.

They should represent:

- creator
- platform
- post ID
- media type
- post date
- views used for calculations
- source field used for views
- likes
- comments
- thumbnail
- sync time

These records help prove what content existed and how it performed at the time of sync.

### View Snapshots

View snapshots are daily platform-level records.

They should represent:

- creator
- platform
- snapshot date
- cumulative views
- recent post count
- follower count
- sync time

These records help calculate performance changes over time.

### Monthly Metrics

Monthly metrics summarize creator performance by creator, platform, year, and month.

They currently represent:

- total views
- post count
- follower count
- sync time

Important note: the current code updates monthly metrics from a rolling 30-day calculation. For true payroll accuracy, monthly payout records should eventually use calendar-month snapshots and be locked after review.

## Data Collection

The dashboard currently collects data through sync routes.

Instagram data is collected through RapidAPI.

TikTok data is collected through Apify.

The sync process:

1. Finds the creator.
2. Scrapes their connected platforms.
3. Stores a daily view snapshot.
4. Stores or refreshes post snapshots.
5. Updates monthly metrics.
6. Returns sync results to the dashboard.

Syncing can happen:

- manually for one creator
- through the daily cron sync route for all active creators

## Payout Logic

The dashboard currently estimates creator payout using:

```text
payout = base fee + ((total views / 1,000) * rate per thousand views)
```

For shorter ranges like 7, 14, or 30 days, the dashboard uses view differences from snapshots.

For selected months, the dashboard uses stored monthly metrics.

For all-time totals, the dashboard groups monthly metrics to avoid double-counting base fees across platforms.

## What The Dashboard Should Be Trusted For Today

The dashboard can currently be trusted as an operational view for:

- tracking creators
- syncing social data
- seeing recent performance
- reviewing posts
- estimating monthly payout amounts
- identifying top creators and top posts

## What Needs To Become Stronger Before Payroll Is Fully Reliable

The dashboard should not rely only on live or rolling numbers for final payment decisions.

To make monthly payments reliable, the app should add a formal monthly payout workflow:

- generate payout statements for a specific calendar month
- freeze the numbers used for payment
- allow manual adjustments
- allow notes
- track review status
- track approval status
- track paid status
- preserve historical payout records even if a post changes later

## Recommended Future Scope

### Monthly Payout Statements

Add a table and screen for locked monthly payout records.

A payout statement should include:

- creator
- month
- year
- Instagram views
- TikTok views
- total views
- eligible post count
- base fee
- view bonus
- affiliate amount
- manual adjustment
- final payout
- notes
- status

Suggested statuses:

- Draft
- Needs Review
- Approved
- Paid

### Calendar-Month Accuracy

Move final payout logic from rolling 30-day windows to true calendar-month windows.

Example:

```text
January payout = posts and views from January 1 to January 31
```

This is different from:

```text
last 30 days from today
```

### Audit Trail

Add an audit trail so it is clear:

- when data was synced
- what numbers changed
- who approved a payout
- when a payout was marked paid
- whether any manual adjustment was made

### Exceptions And Manual Review

Add review tools for cases like:

- creator did not meet posting target
- creator joined mid-month
- creator paused mid-month
- platform data failed to sync
- post was deleted
- suspicious spike or missing views
- manual bonus or deduction

### Exporting

Add export options for bookkeeping.

Useful exports:

- monthly payout CSV
- creator-level payout statement
- post evidence report

## Out Of Scope For Now

The dashboard does not currently need to be:

- a creator-facing portal
- an invoice generation system
- a bank payment system
- a full CRM
- a content approval tool
- a contract signing platform

Those could be added later, but the current product should stay focused on data collection, performance tracking, and payout confidence.

## Product North Star

The north star is simple:

At the end of every month, the business should be able to open the dashboard, review each creator, understand exactly why they are owed a certain amount, approve the payout, and keep a permanent record of that decision.


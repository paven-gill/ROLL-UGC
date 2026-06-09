import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { WISE_BASE, getWiseToken, fetchWiseProfiles, pickWiseProfile, wiseSignedFetch } from "@/lib/wise";

async function attemptWiseTransfer(
  amount: number,
  recipientEmail: string,
  creatorName: string,
  reference: string,
): Promise<{ transfer_id: string | null; error: string | null }> {
  const token = await getWiseToken();
  if (!token) return { transfer_id: null, error: "Wise not configured" };

  try {
    let profiles: any[];
    try {
      profiles = await fetchWiseProfiles(token);
    } catch {
      return { transfer_id: null, error: "Wise auth failed" };
    }
    const profile = pickWiseProfile(profiles);
    if (!profile) return { transfer_id: null, error: "No Wise business profile found" };

    // Create recipient
    const recpRes = await fetch(`${WISE_BASE}/v1/accounts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: profile.id,
        accountHolderName: creatorName,
        currency: "USD",
        type: "email",
        details: { email: recipientEmail },
      }),
    });
    if (!recpRes.ok) {
      return { transfer_id: null, error: `Recipient: ${await recpRes.text()}` };
    }
    const recipient = await recpRes.json();

    // Create quote. Must be the profile-scoped endpoint — POST /v3/quotes
    // (profile in body) produces a quote Wise rejects at transfer time with
    // "Quote is missing profile."
    const quoteRes = await fetch(`${WISE_BASE}/v3/profiles/${profile.id}/quotes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceCurrency: "USD",
        targetCurrency: "USD",
        sourceAmount: amount,
        targetAccount: recipient.id,
      }),
    });
    if (!quoteRes.ok) {
      return { transfer_id: null, error: `Quote: ${await quoteRes.text()}` };
    }
    const quote = await quoteRes.json();

    // Create transfer
    const txRes = await fetch(`${WISE_BASE}/v1/transfers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        targetAccount: recipient.id,
        quoteUuid: quote.id,
        customerTransactionId: crypto.randomUUID(),
        details: { reference },
      }),
    });
    if (!txRes.ok) {
      return { transfer_id: null, error: `Transfer: ${await txRes.text()}` };
    }
    const transfer = await txRes.json();

    // Fund from balance. This is SCA-protected: wiseSignedFetch answers Wise's
    // signature challenge using the private key in WISE_PRIVATE_KEY.
    const fundRes = await wiseSignedFetch(
      `${WISE_BASE}/v3/profiles/${profile.id}/transfers/${transfer.id}/payments`,
      token,
      { type: "BALANCE" },
    );
    if (!fundRes.ok) {
      const body = await fundRes.text();
      const hint = fundRes.status === 403
        ? "SCA signature rejected — check the public key is uploaded to Wise and WISE_PRIVATE_KEY matches it"
        : "insufficient balance or other Wise error";
      return {
        transfer_id: String(transfer.id),
        error: `Funded but transfer not sent (${hint}): ${body}`,
      };
    }

    return { transfer_id: String(transfer.id), error: null };
  } catch (e: any) {
    return { transfer_id: null, error: e?.message ?? "Unknown error" };
  }
}

// POST /api/payout-cycles/pay
// type: "pending"     — existing payout_cycles row, just update + pay
// type: "in_progress" — cycle still in creator_cycles; close it, create record, new cycle, pay
export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    type,
    cycle_id,
    creator_id,
    creator_name,
    cycle_start_date,
    cycle_end_date,
    start_views = 0,
    end_views = 0,
    views_earned = 0,
    base_fee,
    view_bonus,
    bonus_amount = 0,
    bonus_note = "",
    recipient_wise_email,
  } = body;

  const db = createServerClient();
  const total = parseFloat((base_fee + view_bonus + (bonus_amount ?? 0)).toFixed(2));
  let finalCycleId = cycle_id;

  // View counts are NOT NULL in the DB. The destructuring defaults above only
  // cover `undefined`; a creator with no view data (e.g. didn't finish the 30
  // posts, so no view bonus) comes through as explicit `null`. Coalesce to 0 so
  // the payout still goes through at the correct (no-bonus) amount.
  const safeStartViews = start_views ?? 0;
  const safeEndViews = end_views ?? 0;
  const safeViewsEarned = views_earned ?? 0;

  if (type === "in_progress") {
    // Close the cycle: create payout_cycles record
    const { data: newCycle, error: insertErr } = await db
      .from("payout_cycles")
      .upsert(
        {
          creator_id,
          cycle_start_date,
          cycle_end_date,
          start_views: safeStartViews,
          end_views: safeEndViews,
          views_earned: safeViewsEarned,
          base_fee,
          view_bonus,
          bonus_amount: bonus_amount ?? 0,
          bonus_note: bonus_note || null,
          payout_amount: total,
          status: "paid",
          paid_at: new Date().toISOString(),
        },
        { onConflict: "creator_id,cycle_start_date" },
      )
      .select()
      .single();

    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });
    finalCycleId = newCycle.id;

    // Get latest snapshots as new baseline for the next cycle
    const { data: snaps } = await db
      .from("view_snapshots")
      .select("platform, cumulative_views")
      .eq("creator_id", creator_id)
      .order("snapshot_date", { ascending: false });

    const byPlatform = new Map<string, number>();
    for (const s of snaps ?? []) {
      if (!byPlatform.has(s.platform)) byPlatform.set(s.platform, s.cumulative_views ?? 0);
    }
    const newBaseline = Array.from(byPlatform.values()).reduce((a, b) => a + b, 0);

    // Start next cycle from the day after this cycle ended
    const nextStart = new Date(cycle_end_date + "T00:00:00Z");
    nextStart.setDate(nextStart.getDate() + 1);
    const nextEnd = new Date(nextStart);
    nextEnd.setDate(nextEnd.getDate() + 30);

    await db.from("creator_cycles").update({
      cycle_start_date: nextStart.toISOString().split("T")[0],
      cycle_end_date: nextEnd.toISOString().split("T")[0],
      baseline_views: newBaseline,
      updated_at: new Date().toISOString(),
    }).eq("creator_id", creator_id);

  } else {
    // Pending: update existing row with bonus + mark paid
    const { error } = await db.from("payout_cycles").update({
      bonus_amount: bonus_amount ?? 0,
      bonus_note: bonus_note || null,
      payout_amount: total,
      status: "paid",
      paid_at: new Date().toISOString(),
    }).eq("id", cycle_id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Persist wise_email on creator for next time
  if (recipient_wise_email?.trim() && creator_id) {
    try {
      await db.from("creators").update({ wise_email: recipient_wise_email.trim() }).eq("id", creator_id);
    } catch {}
  }

  // Attempt Wise transfer
  let wiseResult: { transfer_id: string | null; error: string | null } = { transfer_id: null, error: null };

  if (recipient_wise_email?.trim()) {
    wiseResult = await attemptWiseTransfer(
      total,
      recipient_wise_email.trim(),
      creator_name ?? "Creator",
      `UGC Payout · ${cycle_start_date} → ${cycle_end_date}`,
    );

    if (finalCycleId) {
      try {
        await db.from("payout_cycles").update({
          wise_transfer_id: wiseResult.transfer_id,
          wise_transfer_status: wiseResult.error ? "queued" : "sent",
        }).eq("id", finalCycleId);
      } catch {}
    }
  }

  return NextResponse.json({
    paid: true,
    cycle_id: finalCycleId,
    wise_sent: !wiseResult.error && !!wiseResult.transfer_id,
    wise_transfer_id: wiseResult.transfer_id,
    wise_error: wiseResult.error,
  });
}

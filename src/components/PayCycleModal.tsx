"use client";

import { useState } from "react";
import { X, Building2, CheckCircle2, AlertCircle } from "lucide-react";

export interface CycleForPay {
  id: string;
  creator_id: string;
  creator_name: string;
  instagram_username: string | null;
  tiktok_username: string | null;
  cycle_start_date: string;
  cycle_end_date: string;
  start_views: number;
  end_views: number | null;
  views_earned: number;
  base_fee: number;
  view_bonus: number;
  payout_amount: number;
  status: "pending" | "paid" | "in_progress";
}

interface Props {
  cycle: CycleForPay;
  onClose: () => void;
  onPaid: () => void;
}

// Interim: payouts are recorded in the dashboard but sent manually in Wise.
// Opening this in a new tab drops you into Wise's Send money flow.
const WISE_SEND_URL = "https://wise.com/send";

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDate(s: string) {
  return new Date(s + "T00:00:00").toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

type PayResult = {
  paid: boolean;
  wise_sent: boolean;
  wise_error: string | null;
  wise_transfer_id: string | null;
};

export default function PayCycleModal({ cycle, onClose, onPaid }: Props) {
  const [bonusAmount, setBonusAmount] = useState("");
  const [bonusNote, setBonusNote]   = useState("");
  const [paying, setPaying]         = useState(false);
  const [result, setResult]         = useState<PayResult | null>(null);

  const bonus = parseFloat(bonusAmount) || 0;
  const total = cycle.base_fee + cycle.view_bonus + bonus;

  async function handlePay() {
    setPaying(true);
    try {
      const res = await fetch("/api/payout-cycles/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: cycle.status === "in_progress" ? "in_progress" : "pending",
          cycle_id: cycle.id,
          creator_id: cycle.creator_id,
          creator_name: cycle.creator_name,
          cycle_start_date: cycle.cycle_start_date,
          cycle_end_date: cycle.cycle_end_date,
          start_views: cycle.start_views,
          end_views: cycle.end_views,
          views_earned: cycle.views_earned,
          base_fee: cycle.base_fee,
          view_bonus: cycle.view_bonus,
          bonus_amount: bonus,
          bonus_note: bonusNote,
          // Interim: don't trigger the (currently blocked) Wise API send —
          // record only, then open Wise so the user pays manually.
          recipient_wise_email: null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult({ paid: false, wise_sent: false, wise_error: data.error ?? "Failed", wise_transfer_id: null });
      } else {
        setResult({ paid: true, wise_sent: false, wise_error: null, wise_transfer_id: null });
        // Open Wise in a new tab so they can complete the payment manually.
        window.open(WISE_SEND_URL, "_blank", "noopener,noreferrer");
      }
    } catch {
      setResult({ paid: false, wise_sent: false, wise_error: "Network error", wise_transfer_id: null });
    }
    setPaying(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-[#0b0b12] border border-white/[0.12] rounded-2xl w-full max-w-md shadow-[0_32px_80px_rgba(0,0,0,0.8)]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.08]">
          <div>
            <h2 className="text-white font-semibold text-sm">Pay {cycle.creator_name}</h2>
            <p className="text-gray-600 text-xs mt-0.5">
              {fmtDate(cycle.cycle_start_date)} → {fmtDate(cycle.cycle_end_date)}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-600 hover:text-white transition-colors p-1">
            <X size={15} />
          </button>
        </div>

        {result ? (
          /* ── Result ── */
          <div className="px-6 py-6 space-y-4">
            {result.paid ? (
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <CheckCircle2 size={18} className="text-emerald-400 mt-0.5 shrink-0" />
                  <div className="space-y-1">
                    <p className="text-white font-medium text-sm">Payout recorded ✓</p>
                    <p className="text-gray-500 text-xs">
                      Wise opened in a new tab — finish the payment there.
                    </p>
                  </div>
                </div>

                {/* What to enter in Wise */}
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 space-y-2">
                  <p className="text-gray-500 text-[11px] uppercase tracking-wide">Send in Wise</p>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Recipient</span>
                    <span className="text-white font-medium">{cycle.creator_name}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Amount</span>
                    <span className="text-emerald-400 font-bold tabular-nums">${total.toFixed(2)}</span>
                  </div>
                </div>

                <button
                  onClick={() => window.open(WISE_SEND_URL, "_blank", "noopener,noreferrer")}
                  className="w-full border border-white/[0.12] hover:border-white/[0.25] text-gray-300 hover:text-white px-4 py-2 rounded-lg text-xs transition-all"
                >
                  Open Wise again
                </button>
              </div>
            ) : (
              <div className="flex items-start gap-3">
                <AlertCircle size={18} className="text-red-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-red-400 font-medium text-sm">Payment failed</p>
                  <p className="text-gray-500 text-xs mt-1">{result.wise_error}</p>
                </div>
              </div>
            )}
            <button
              onClick={() => { if (result.paid) onPaid(); else onClose(); }}
              className="w-full bg-emerald-500 hover:bg-emerald-400 text-black font-semibold px-4 py-2.5 rounded-lg text-sm transition-all"
            >
              {result.paid ? "Done" : "Close"}
            </button>
          </div>

        ) : (
          /* ── Invoice form ── */
          <div className="px-6 py-5 space-y-5">

            {/* Breakdown */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Base fee</span>
                <span className="text-white font-medium">${cycle.base_fee.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">
                  View bonus
                  <span className="text-gray-600 text-xs ml-1.5">· {fmt(cycle.views_earned)} views</span>
                </span>
                <span className="text-white font-medium">${cycle.view_bonus.toFixed(2)}</span>
              </div>

              {/* Bonus row */}
              <div className="pt-2 border-t border-white/[0.06]">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-gray-400 text-sm shrink-0">Bonus</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="Reason (optional)"
                      value={bonusNote}
                      onChange={e => setBonusNote(e.target.value)}
                      className="bg-white/[0.04] border border-white/[0.08] focus:border-white/[0.2] rounded-lg px-2.5 py-1.5 text-xs text-gray-300 placeholder-gray-600 focus:outline-none w-32 transition-colors"
                    />
                    <div className="relative">
                      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500 text-xs">$</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0.00"
                        value={bonusAmount}
                        onChange={e => setBonusAmount(e.target.value)}
                        className="bg-white/[0.04] border border-white/[0.08] focus:border-white/[0.2] rounded-lg pl-5 pr-2.5 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none w-24 tabular-nums transition-colors"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Total */}
              <div className="flex justify-between items-center pt-2 border-t border-white/[0.06]">
                <span className="text-white font-semibold text-sm">Total</span>
                <span className="text-emerald-400 font-bold text-xl tabular-nums">${total.toFixed(2)}</span>
              </div>
            </div>

            {/* Manual-pay note */}
            <div className="flex items-start gap-2 bg-white/[0.02] border border-white/[0.06] rounded-lg px-3 py-2.5">
              <Building2 size={12} className="text-gray-500 mt-0.5 shrink-0" />
              <p className="text-gray-500 text-[11px] leading-relaxed">
                This records the payout and opens <span className="text-gray-300">Wise</span> in a new tab,
                where you send the payment manually to <span className="text-gray-300">{cycle.creator_name}</span>.
              </p>
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              <button
                onClick={onClose}
                className="flex-1 border border-white/[0.1] hover:border-white/[0.2] text-gray-400 hover:text-white px-4 py-2.5 rounded-lg text-sm transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handlePay}
                disabled={paying}
                className="flex-1 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed text-black font-semibold px-4 py-2.5 rounded-lg text-sm transition-all shadow-[0_0_20px_rgba(52,211,153,0.2)]"
              >
                {paying ? "Recording…" : `Mark $${total.toFixed(2)} paid & open Wise`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

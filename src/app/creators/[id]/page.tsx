"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, RefreshCw, Instagram, Eye, FileVideo, DollarSign,
  Check, X, Pause, Play, Trash2, Pencil, TrendingUp,
  type LucideIcon,
} from "lucide-react";
import type { Creator, MonthlyMetrics } from "@/types";

interface CreatorDetail extends Creator {
  metrics: MonthlyMetrics[];
}

interface ActiveCycle {
  cycle_start_date: string;
  cycle_end_date: string;
  baseline_views: number;
  views_earned: number;
  days_remaining: number;
  post_count: number;
}

interface CycleHistoryRow {
  id: string;
  cycle_start_date: string;
  cycle_end_date: string;
  views_earned: number;
  payout_amount: number | null;
  base_fee: number;
  view_bonus: number;
  post_count: number;
  status: "pending" | "paid" | "in_progress";
}

interface CycleData {
  activeCycle: ActiveCycle | null;
  cycleHistory: CycleHistoryRow[];
  lastSyncedAt: string | null;
}

interface PostRow {
  post_id: string;
  platform: string;
  media_type: string | null;
  taken_at: string | null;
  view_count_used: number;
  view_field_used: string;
  like_count: number;
  comment_count: number;
  thumbnail_url: string | null;
  synced_at: string;
}

type EditSection = "payment" | "socials" | "program" | null;

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtShortDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getAllTimePostCount(creator: CreatorDetail) {
  let allPosts = 0;
  for (const m of creator.metrics) allPosts += m.post_count;
  return allPosts;
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function StatCard({
  Icon, label, value, sub, color,
}: {
  Icon: LucideIcon; label: string; value: string; sub?: string;
  color?: "green" | "yellow";
}) {
  return (
    <div className="bg-[#0d0d15]/80 backdrop-blur-xl border border-white/[0.14] rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-gray-500 text-[11px] font-medium uppercase tracking-wide">{label}</p>
        <Icon size={14} className="text-gray-600"/>
      </div>
      <p className={`text-2xl font-bold ${
        color === "green" ? "text-emerald-400" :
        color === "yellow" ? "text-yellow-400" :
        "text-white"
      }`}>{value}</p>
      {sub && (
        <p className={`text-xs mt-1 ${
          color === "green" ? "text-emerald-600" :
          color === "yellow" ? "text-yellow-600" :
          "text-gray-600"
        }`}>{sub}</p>
      )}
    </div>
  );
}

function SectionCard({
  title, editing, onEdit, onCancel, onSave, saving, children,
}: {
  title: string;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => Promise<void>;
  saving: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-[#0d0d15]/80 backdrop-blur-xl border border-white/[0.14] rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.1]">
        <h2 className="text-sm font-semibold text-gray-200">{title}</h2>
        {editing ? (
          <div className="flex items-center gap-3">
            <button
              onClick={onSave}
              disabled={saving}
              className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 disabled:opacity-50 transition-colors"
            >
              <Check size={12}/> Save
            </button>
            <button
              onClick={onCancel}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-white transition-colors"
            >
              <X size={12}/> Cancel
            </button>
          </div>
        ) : (
          <button onClick={onEdit} className="text-gray-600 hover:text-gray-300 transition-colors">
            <Pencil size={13}/>
          </button>
        )}
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-white/[0.1] last:border-0">
      <span className="text-gray-500 text-sm">{label}</span>
      <span className="text-white text-sm font-medium">{value}</span>
    </div>
  );
}

function Field({
  label, value, onChange, placeholder, type = "text",
}: {
  label: string; value: string;
  onChange: (v: string) => void;
  placeholder?: string; type?: string;
}) {
  return (
    <div>
      <label className="text-gray-500 text-xs mb-1.5 block">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-emerald-500/60 focus:bg-white/[0.06] focus:shadow-[0_0_0_3px_rgba(52,211,153,0.08)] transition-all"
      />
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function CreatorPage({ params }: { params: { id: string } }) {
  const router = useRouter();

  const [creator,     setCreator]     = useState<CreatorDetail | null>(null);
  const [cycleData,   setCycleData]   = useState<CycleData | null>(null);
  const [syncing,     setSyncing]     = useState(false);
  const [syncMsg,     setSyncMsg]     = useState<string | null>(null);
  const [editSection, setEditSection] = useState<EditSection>(null);
  const [saving,      setSaving]      = useState(false);
  const [posts,       setPosts]       = useState<PostRow[]>([]);

  const [paymentForm, setPaymentForm] = useState({
    base_fee: "", rate_per_thousand_views: "", affiliate_percentage: "",
  });
  const [socialsForm, setSocialsForm] = useState({ instagram_username: "", tiktok_username: "" });
  const [programForm, setProgramForm] = useState({
    name: "", monthly_target: "", joined_at: "",
  });

  const fetchCreator = useCallback(async () => {
    const [res, postsRes, cyclesRes] = await Promise.all([
      fetch(`/api/creators/${params.id}`),
      fetch(`/api/posts/${params.id}`),
      fetch(`/api/creators/${params.id}/cycles`),
    ]);
    const data: CreatorDetail = await res.json();
    const postsData: PostRow[] = await postsRes.json();
    const cyclesRaw = await cyclesRes.json();
    const cyclesData: CycleData = Array.isArray(cyclesRaw?.cycleHistory)
      ? cyclesRaw
      : { activeCycle: null, cycleHistory: [], lastSyncedAt: null };
    setPosts(Array.isArray(postsData) ? postsData : []);
    setCycleData(cyclesData);
    setCreator(data);
    setPaymentForm({
      base_fee: String(data.base_fee),
      rate_per_thousand_views: String(data.rate_per_thousand_views),
      affiliate_percentage: String(data.affiliate_percentage ?? 0),
    });
    setSocialsForm({ instagram_username: data.instagram_username || "", tiktok_username: data.tiktok_username || "" });
    setProgramForm({
      name: data.name,
      monthly_target: String(data.monthly_target ?? 30),
      joined_at: data.joined_at || new Date().toISOString().split("T")[0],
    });
  }, [params.id]);

  useEffect(() => { fetchCreator(); }, [fetchCreator]);

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    await fetch(`/api/creators/${params.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await fetchCreator();
    setSaving(false);
    setEditSection(null);
  }

  async function savePayment() {
    await patch({
      base_fee: parseFloat(paymentForm.base_fee) || 0,
      rate_per_thousand_views: parseFloat(paymentForm.rate_per_thousand_views) || 2,
      affiliate_percentage: parseFloat(paymentForm.affiliate_percentage) || 0,
    });
  }

  async function saveSocials() {
    await patch({
      instagram_username: socialsForm.instagram_username.trim().replace("@", "") || null,
      tiktok_username: socialsForm.tiktok_username.trim().replace("@", "") || null,
    });
  }

  async function saveProgram() {
    await patch({
      name: programForm.name.trim() || creator!.name,
      monthly_target: parseInt(programForm.monthly_target) || 30,
      joined_at: programForm.joined_at,
    });
  }

  async function toggleStatus() {
    if (!creator) return;
    await patch({ active: !creator.active });
  }

  async function deleteCreator() {
    if (!confirm(`Remove ${creator?.name}? This cannot be undone.`)) return;
    await fetch(`/api/creators/${params.id}`, { method: "DELETE" });
    router.push("/");
  }

  async function sync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch(`/api/sync/${params.id}`, { method: "POST" });
      const data = await res.json();
      await fetchCreator();
      if (data.instagram_error && data.tiktok_error) {
        setSyncMsg(`Error: ${data.instagram_error}`);
      } else if (data.cycle_error) {
        setSyncMsg(`Posts synced, but cycle error: ${data.cycle_error}`);
      } else {
        const parts: string[] = [];
        if (data.instagram) parts.push(`IG ${fmt(data.instagram.cumulative_views ?? 0)} views`);
        if (data.tiktok)    parts.push(`TT ${fmt(data.tiktok.cumulative_views ?? 0)} views`);
        if (data.instagram_error) parts.push(`IG error`);
        if (data.tiktok_error)    parts.push(`TT error`);
        setSyncMsg(`${parts.join(" · ")} · cycle: ${data.cycle?.action ?? "unknown"}`);
      }
    } catch (e) {
      setSyncMsg(`Failed: ${String(e)}`);
    } finally {
      setSyncing(false);
    }
  }

  if (!creator) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-600 text-sm">
        Loading...
      </div>
    );
  }

  const allPosts = getAllTimePostCount(creator);
  const allViews = cycleData?.activeCycle
    ? cycleData.activeCycle.baseline_views + cycleData.activeCycle.views_earned
    : 0;
  const totalPaidOut = (cycleData?.cycleHistory ?? [])
    .filter(c => c.status !== "in_progress")
    .reduce((sum, c) => sum + (c.payout_amount ?? 0), 0);
  const monthly_target = creator.monthly_target ?? 30;

  return (
    <div className="min-h-screen text-white">
      {/* ── Header ── */}
      <div className="border-b border-white/[0.08] bg-[#07070e]/70 backdrop-blur-2xl px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          {/* Left */}
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.push("/")}
              className="text-gray-500 hover:text-white transition-colors"
            >
              <ArrowLeft size={18}/>
            </button>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-lg font-semibold">{creator.name}</h1>
                <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full font-medium border ${
                  creator.active
                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                    : "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${creator.active ? "bg-emerald-400" : "bg-yellow-400"}`}/>
                  {creator.active ? "Active" : "Paused"}
                </span>
              </div>
              <div className="flex items-center gap-3 mt-0.5 text-gray-600 text-xs">
                {creator.instagram_username && (
                  <span className="flex items-center gap-1 text-blue-400/60">
                    <Instagram size={10}/> @{creator.instagram_username}
                  </span>
                )}
                {creator.joined_at && (
                  <span>Joined {fmtDate(creator.joined_at)}</span>
                )}
              </div>
            </div>
          </div>

          {/* Right */}
          <div className="flex items-center gap-2">
            {syncMsg && (
              <span className={`text-xs ${syncMsg.startsWith("Error") || syncMsg.startsWith("Failed") ? "text-red-400" : "text-emerald-400"}`}>
                {syncMsg}
              </span>
            )}
            <button
              onClick={toggleStatus}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                creator.active
                  ? "border-yellow-500/20 text-yellow-400 hover:bg-yellow-500/10"
                  : "border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/10"
              }`}
            >
              {creator.active ? <Pause size={13}/> : <Play size={13}/>}
              {creator.active ? "Pause" : "Activate"}
            </button>
            <button
              onClick={sync}
              disabled={syncing}
              className="flex items-center gap-1.5 bg-white/[0.04] border border-white/[0.08] hover:border-white/[0.18] text-white px-3 py-1.5 rounded-lg text-sm transition-all disabled:opacity-50"
            >
              <RefreshCw size={13} className={syncing ? "animate-spin" : ""}/>
              {syncing ? "Syncing..." : "Sync"}
            </button>
          </div>
        </div>
      </div>

      {/* ── Content (centered) ── */}
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-5">

        {/* All-time stat cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            Icon={Eye}       label="All-Time Views"
            value={fmt(allViews)}
            sub={`${cycleData ? cycleData.cycleHistory.length : 0} cycles completed`}
          />
          <StatCard
            Icon={FileVideo} label="All-Time Posts"
            value={allPosts.toLocaleString()}
            sub={`Target: ${monthly_target}/mo`}
          />
          <StatCard
            Icon={DollarSign} label="Total Paid Out"
            value={`$${totalPaidOut.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            sub="Since joining"
            color="green"
          />
          <StatCard
            Icon={TrendingUp} label="Affiliate Rate"
            value={`${creator.affiliate_percentage ?? 0}%`}
            sub="Commission"
          />
        </div>

        {/* Payment Terms + Socials */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SectionCard
            title="Payment Terms"
            editing={editSection === "payment"}
            onEdit={() => setEditSection("payment")}
            onCancel={() => setEditSection(null)}
            onSave={savePayment}
            saving={saving}
          >
            {editSection === "payment" ? (
              <div className="space-y-3">
                <Field
                  label="Base Fee ($ / month)"
                  value={paymentForm.base_fee}
                  onChange={v => setPaymentForm(f => ({ ...f, base_fee: v }))}
                  type="number"
                />
                <Field
                  label="Rate per 1K Views ($)"
                  value={paymentForm.rate_per_thousand_views}
                  onChange={v => setPaymentForm(f => ({ ...f, rate_per_thousand_views: v }))}
                  type="number"
                />
                <Field
                  label="Affiliate Commission (%)"
                  value={paymentForm.affiliate_percentage}
                  onChange={v => setPaymentForm(f => ({ ...f, affiliate_percentage: v }))}
                  type="number"
                />
              </div>
            ) : (
              <>
                <InfoRow label="Base Fee"    value={`$${creator.base_fee.toFixed(2)} / month`} />
                <InfoRow label="View Rate"   value={`$${creator.rate_per_thousand_views} / 1K views`} />
                <InfoRow label="Affiliate %" value={`${creator.affiliate_percentage ?? 0}%`} />
              </>
            )}
          </SectionCard>

          <SectionCard
            title="Social Accounts"
            editing={editSection === "socials"}
            onEdit={() => setEditSection("socials")}
            onCancel={() => setEditSection(null)}
            onSave={saveSocials}
            saving={saving}
          >
            {editSection === "socials" ? (
              <div className="space-y-3">
                <Field
                  label="Instagram Username"
                  value={socialsForm.instagram_username}
                  onChange={v => setSocialsForm(f => ({ ...f, instagram_username: v }))}
                  placeholder="@username"
                />
                <Field
                  label="TikTok Username"
                  value={socialsForm.tiktok_username}
                  onChange={v => setSocialsForm(f => ({ ...f, tiktok_username: v }))}
                  placeholder="@username"
                />
              </div>
            ) : (
              <div className="space-y-2">
                {creator.instagram_username ? (
                  <InfoRow label="Instagram" value={`@${creator.instagram_username}`} />
                ) : (
                  <button
                    onClick={() => setEditSection("socials")}
                    className="text-sm text-gray-600 hover:text-emerald-400 transition-colors"
                  >
                    + Connect Instagram
                  </button>
                )}
                {creator.tiktok_username ? (
                  <InfoRow label="TikTok" value={`@${creator.tiktok_username}`} />
                ) : (
                  <button
                    onClick={() => setEditSection("socials")}
                    className="text-sm text-gray-600 hover:text-emerald-400 transition-colors"
                  >
                    + Connect TikTok
                  </button>
                )}
              </div>
            )}
          </SectionCard>
        </div>

        {/* Program Settings */}
        <SectionCard
          title="Program Settings"
          editing={editSection === "program"}
          onEdit={() => setEditSection("program")}
          onCancel={() => setEditSection(null)}
          onSave={saveProgram}
          saving={saving}
        >
          {editSection === "program" ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Field
                label="Creator Name"
                value={programForm.name}
                onChange={v => setProgramForm(f => ({ ...f, name: v }))}
              />
              <Field
                label="Monthly Post Target"
                value={programForm.monthly_target}
                onChange={v => setProgramForm(f => ({ ...f, monthly_target: v }))}
                type="number"
              />
              <Field
                label="Date Joined"
                value={programForm.joined_at}
                onChange={v => setProgramForm(f => ({ ...f, joined_at: v }))}
                type="date"
              />
            </div>
          ) : (
            <div className="space-y-4">
              {/* Basic info */}
              <div className="grid grid-cols-3 gap-6">
                <div>
                  <p className="text-gray-500 text-xs mb-1">Monthly Target</p>
                  <p className="text-white text-sm font-medium">{monthly_target} posts</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs mb-1">Date Joined</p>
                  <p className="text-white text-sm font-medium">{fmtDate(creator.joined_at)}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs mb-1">Status</p>
                  <p className={`text-sm font-medium ${creator.active ? "text-emerald-400" : "text-yellow-400"}`}>
                    {creator.active ? "Active" : "Paused"}
                  </p>
                </div>
              </div>

              {/* Active cycle details */}
              {cycleData?.activeCycle && (() => {
                const ac = cycleData.activeCycle!;
                const projectedPayout = creator.base_fee + (ac.views_earned / 1000) * creator.rate_per_thousand_views;
                return (
                  <>
                    <div className="border-t border-white/[0.07] pt-4">
                      <div className="grid grid-cols-4 gap-6 mb-4">
                        <div>
                          <p className="text-gray-500 text-xs mb-1">Onboarding Sync</p>
                          <p className="text-white text-sm font-medium">{fmtDate(ac.cycle_start_date)}</p>
                          <p className="text-gray-600 text-xs mt-0.5">Baseline: {fmt(ac.baseline_views)} views</p>
                        </div>
                        <div>
                          <p className="text-gray-500 text-xs mb-1">Current Cycle</p>
                          <p className="text-white text-sm font-medium">
                            {fmtShortDate(ac.cycle_start_date)} → {fmtShortDate(ac.cycle_end_date)}
                          </p>
                        </div>
                        <div>
                          <p className="text-gray-500 text-xs mb-1">Days Remaining</p>
                          <p className="text-white text-sm font-medium">{ac.days_remaining} days</p>
                        </div>
                        <div>
                          <p className="text-gray-500 text-xs mb-1">Last Synced</p>
                          <p className="text-white text-sm font-medium">{fmtDate(cycleData.lastSyncedAt)}</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-4">
                        <div className="bg-white/[0.03] border border-white/[0.05] rounded-lg p-3">
                          <p className="text-gray-500 text-xs mb-1">Posts This Cycle</p>
                          <p className="text-white text-sm font-semibold">
                            <span className={ac.post_count >= monthly_target ? "text-emerald-400" : ""}>{ac.post_count}</span>
                            <span className="text-gray-600 font-normal">/{monthly_target}</span>
                          </p>
                        </div>
                        <div className="bg-white/[0.03] border border-white/[0.05] rounded-lg p-3">
                          <p className="text-gray-500 text-xs mb-1">Views Earned</p>
                          <p className="text-white text-sm font-semibold">{fmt(ac.views_earned)}</p>
                        </div>
                        <div className="bg-white/[0.03] border border-white/[0.05] rounded-lg p-3">
                          <p className="text-gray-500 text-xs mb-1">View Bonus</p>
                          <p className="text-white text-sm font-semibold">
                            ${((ac.views_earned / 1000) * creator.rate_per_thousand_views).toFixed(2)}
                          </p>
                        </div>
                        <div className="bg-white/[0.03] border border-white/[0.05] rounded-lg p-3">
                          <p className="text-gray-500 text-xs mb-1">Projected Payout</p>
                          <p className="text-emerald-400 text-sm font-semibold">${projectedPayout.toFixed(2)}</p>
                        </div>
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          )}
        </SectionCard>

        {/* Cycle History */}
        <div className="bg-[#0d0d15]/80 backdrop-blur-xl border border-white/[0.14] rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-white/[0.1]">
            <h2 className="text-sm font-semibold text-gray-200">Cycle History</h2>
          </div>
          {!cycleData || cycleData.cycleHistory.length === 0 ? (
            <p className="px-5 py-6 text-gray-600 text-sm">No cycles yet — sync to get started.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 text-xs border-b border-white/[0.1]">
                  <th className="text-left px-5 py-3">Cycle</th>
                  <th className="text-right px-4 py-3">Views Earned</th>
                  <th className="text-right px-4 py-3">Posts</th>
                  <th className="text-right px-4 py-3">Payout</th>
                  <th className="text-right px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {cycleData.cycleHistory.map(c => (
                  <tr key={c.id} className="border-b border-white/[0.04] hover:bg-white/[0.03]">
                    <td className="px-5 py-3 font-medium text-gray-300">
                      {fmtShortDate(c.cycle_start_date)} → {fmtShortDate(c.cycle_end_date)}
                    </td>
                    <td className="px-4 py-3 text-right">{fmt(c.views_earned)}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={c.post_count >= monthly_target ? "text-emerald-400" : "text-yellow-400"}>{c.post_count}</span>
                      <span className="text-gray-600">/{monthly_target}</span>
                    </td>
                    <td className="px-4 py-3 text-right text-emerald-400 font-medium">
                      {c.status === "in_progress"
                        ? `$${(creator.base_fee + (c.views_earned / 1000) * creator.rate_per_thousand_views).toFixed(2)}`
                        : c.payout_amount != null ? `$${c.payout_amount.toFixed(2)}` : <span className="text-gray-600">—</span>
                      }
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full font-medium border ${
                        c.status === "paid"
                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                          : c.status === "in_progress"
                          ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
                          : "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
                      }`}>
                        {c.status === "paid" ? "Paid" : c.status === "in_progress" ? "In Progress" : "Pending"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Individual Posts */}
        {posts.length > 0 && (
          <div className="bg-[#0d0d15]/80 backdrop-blur-xl border border-white/[0.14] rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-white/[0.1]">
              <h2 className="text-sm font-semibold text-gray-200">
                Recent Posts <span className="text-gray-600 font-normal">(last 10)</span>
              </h2>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 text-xs border-b border-white/[0.1]">
                  <th className="text-left px-5 py-3">Post</th>
                  <th className="text-left px-4 py-3">Platform</th>
                  <th className="text-left px-4 py-3">Type</th>
                  <th className="text-right px-4 py-3">Views</th>
                  <th className="text-right px-4 py-3 hidden md:table-cell">Likes</th>
                  <th className="text-right px-4 py-3 hidden md:table-cell">Comments</th>
                </tr>
              </thead>
              <tbody>
                {posts.slice(0, 10).map(p => (
                  <tr key={`${p.post_id}-${p.platform}`} className="border-b border-white/[0.04] hover:bg-white/[0.03]">
                    <td className="px-5 py-2">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg overflow-hidden bg-white/[0.05] shrink-0">
                          {p.thumbnail_url ? (
                            <img
                              src={`/api/proxy-image?url=${encodeURIComponent(p.thumbnail_url)}`}
                              alt=""
                              className="w-full h-full object-cover"
                              onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-gray-700 text-[10px]">—</div>
                          )}
                        </div>
                        <span className="text-gray-400 text-xs">
                          {p.taken_at ? new Date(p.taken_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        p.platform === "instagram" ? "bg-pink-500/10 text-pink-400 border border-pink-500/20" :
                        "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
                      }`}>
                        {p.platform === "instagram" ? "Instagram" : "TikTok"}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        p.media_type === "video" ? "bg-blue-500/10 text-blue-400" :
                        p.media_type === "photo" ? "bg-gray-500/10 text-gray-400" :
                        p.media_type === "carousel" ? "bg-purple-500/10 text-purple-400" :
                        "bg-gray-800 text-gray-600"
                      }`}>
                        {p.media_type ?? "unknown"}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right font-medium">
                      {p.view_count_used > 0 ? fmt(p.view_count_used) : <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-2 text-right hidden md:table-cell text-gray-400 text-xs">
                      {p.like_count > 0 ? fmt(p.like_count) : <span className="text-gray-700">—</span>}
                    </td>
                    <td className="px-4 py-2 text-right hidden md:table-cell text-gray-400 text-xs">
                      {p.comment_count > 0 ? fmt(p.comment_count) : <span className="text-gray-700">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Danger Zone */}
        <div className="border border-red-900/20 rounded-xl p-5">
          <h3 className="text-sm font-medium text-red-400 mb-3">Danger Zone</h3>
          <div className="flex items-center gap-3">
            <button
              onClick={toggleStatus}
              className={`flex items-center gap-2 text-sm px-4 py-2 rounded-lg border transition-colors ${
                creator.active
                  ? "border-yellow-900/40 text-yellow-400 hover:border-yellow-600/60"
                  : "border-emerald-900/40 text-emerald-400 hover:border-emerald-600/60"
              }`}
            >
              {creator.active ? <><Pause size={13}/> Pause Creator</> : <><Play size={13}/> Activate Creator</>}
            </button>
            <button
              onClick={deleteCreator}
              className="flex items-center gap-2 text-sm text-red-400 border border-red-900/30 hover:border-red-600/60 px-4 py-2 rounded-lg transition-colors"
            >
              <Trash2 size={13}/> Remove Creator
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

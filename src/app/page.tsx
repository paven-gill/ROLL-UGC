"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  LayoutDashboard, Users, DollarSign, Zap,
  RefreshCw, Plus, Instagram, Music2,
  Eye, FileVideo, TrendingUp, ChevronRight, ChevronDown, CalendarDays,
  ArrowUpDown, Pencil, Heart, MessageCircle, CheckCircle2, Clock,
  type LucideIcon,
} from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from "recharts";
import AddCreatorModal from "@/components/AddCreatorModal";
import QuickEditModal from "@/components/QuickEditModal";
import type { Creator, MonthlyMetrics } from "@/types";

type Tab = "home" | "creators" | "payouts";
type TimeRangeType = "7d" | "14d" | "30d" | "month" | "all";

interface CreatorRow extends Creator {
  metrics: MonthlyMetrics[];
  completed_payout_total: number;
  completed_views_total: number;
}

interface RangeSummary {
  id: string;
  name: string;
  instagram_username: string | null;
  tiktok_username: string | null;
  ig_views: number;
  tt_views: number;
  total_views: number;
  ig_posts: number;
  tt_posts: number;
  total_posts: number;
  payout: number;
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

interface CycleRecord {
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

interface PayoutEvent {
  date: string;
  creator_name: string;
  cycle_start_date: string;
  cycle_end_date: string;
  base_fee: number;
}

interface ChartPoint {
  name: string;
  Views: number;
  payoutEvents?: PayoutEvent[];
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtMoney(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(n);
}

function fmtDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function getAllTimeSummary(creator: CreatorRow) {
  let allViews = 0, allPosts = 0;
  for (const m of creator.metrics) {
    allViews += m.total_views;
    allPosts += m.post_count;
  }
  // Closed cycles: use the actual recorded payout (base fee + view bonus)
  // Current cycle: add only the view bonus for views not yet in a closed cycle
  const inProgressViews = Math.max(0, allViews - (creator.completed_views_total ?? 0));
  const totalPayout = (creator.completed_payout_total ?? 0)
    + (inProgressViews / 1000) * creator.rate_per_thousand_views;
  return { allViews, allPosts, totalPayout };
}


function getProgramMonths(): Array<{ year: number; month: number }> {
  // Fixed program window: Jan 2026 → Jan 2027, newest first
  const months: Array<{ year: number; month: number }> = [];
  for (let m = 1; m >= 1; m--) months.push({ year: 2027, month: m }); // Jan 2027
  for (let m = 12; m >= 1; m--) months.push({ year: 2026, month: m }); // Dec → Jan 2026
  return months;
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

type NavItem = { id: Tab; label: string; Icon: LucideIcon };

const NAV: NavItem[] = [
  { id: "home",     label: "Home",     Icon: LayoutDashboard },
  { id: "creators", label: "Creators", Icon: Users },
  { id: "payouts",  label: "Payouts",  Icon: DollarSign },
];

function Sidebar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  return (
    <aside className="w-56 bg-[#07070e]/90 backdrop-blur-3xl border-r border-white/[0.1] flex flex-col shrink-0 sticky top-0 h-screen">
      <div className="px-5 py-5 border-b border-white/[0.06]">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 bg-emerald-500 rounded-lg flex items-center justify-center shadow-[0_0_14px_rgba(52,211,153,0.5)]">
            <Zap size={13} className="text-black" />
          </div>
          <span className="font-semibold text-sm text-white">UGC Dashboard</span>
        </div>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {NAV.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => onChange(id)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all text-left border ${
              active === id
                ? "bg-emerald-500/[0.08] border-emerald-500/[0.18] text-white"
                : "border-transparent text-gray-500 hover:text-gray-200 hover:bg-white/[0.04]"
            }`}
          >
            <Icon size={15} className={active === id ? "text-emerald-400 drop-shadow-[0_0_5px_rgba(52,211,153,0.7)]" : ""} />
            {label}
          </button>
        ))}
      </nav>
      <div className="px-5 py-4 border-t border-white/[0.06]">
        <p className="text-gray-700 text-xs">FutureCreator.biz</p>
      </div>
    </aside>
  );
}

// ─── Stat card ───────────────────────────────────────────────────────────────

function Stat({
  label, value, sub, Icon, accent,
}: {
  label: string; value: string; sub?: string;
  Icon?: LucideIcon;
  accent?: boolean;
}) {
  return (
    <div className="bg-[#0d0d15]/80 backdrop-blur-xl border border-white/[0.14] rounded-xl p-5 shadow-[0_8px_32px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.14)]">
      <div className="flex items-center justify-between mb-3">
        <p className="text-gray-500 text-[11px] font-medium uppercase tracking-wide">{label}</p>
        {Icon && <Icon size={14} className="text-gray-600" />}
      </div>
      <p className={`text-2xl font-bold ${accent ? "text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.35)]" : "text-white"}`}>{value}</p>
      {sub && <p className="text-gray-600 text-xs mt-1">{sub}</p>}
    </div>
  );
}

// ─── Time range picker ────────────────────────────────────────────────────────

function TimeRangePicker({
  value, selYear, selMonth, onSelect, showAll = false, monthOnly = false,
}: {
  value: TimeRangeType;
  selYear: number;
  selMonth: number;
  onSelect: (type: TimeRangeType, year?: number, month?: number) => void;
  showAll?: boolean;
  monthOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const months12 = getProgramMonths();

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const label =
    value === "7d"   ? "Last 7 Days" :
    value === "14d"  ? "Last 14 Days" :
    value === "30d"  ? "Last 30 Days" :
    value === "all"  ? "All Time" :
    `${MONTHS[selMonth - 1]} ${selYear}`;

  const ranges: { id: TimeRangeType; label: string }[] = [
    ...(showAll ? [{ id: "all" as TimeRangeType, label: "All Time" }] : []),
    { id: "7d",  label: "Last 7 Days" },
    { id: "14d", label: "Last 14 Days" },
    { id: "30d", label: "Last 30 Days" },
  ];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 bg-[#0d0d15]/80 border border-white/[0.14] hover:border-white/[0.28] rounded-lg px-3 py-2 text-sm text-gray-300 transition-all"
      >
        <CalendarDays size={13} className="text-gray-500" />
        <span>{label}</span>
        <ChevronDown size={12} className={`text-gray-500 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 bg-[#0b0b12]/95 backdrop-blur-2xl border border-white/[0.08] rounded-xl shadow-[0_20px_60px_rgba(0,0,0,0.8)] z-50 w-48 overflow-hidden">
          {/* Range options */}
          {!monthOnly && (
            <div className="p-1">
              {ranges.map(r => (
                <button
                  key={r.id}
                  onClick={() => { onSelect(r.id); setOpen(false); }}
                  className={`w-full text-left px-3 py-2 text-sm rounded-lg transition-colors ${
                    value === r.id
                      ? "bg-white/[0.08] text-white"
                      : "text-gray-400 hover:text-white hover:bg-white/[0.05]"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}

          {/* Month list */}
          <div className={monthOnly ? "p-1" : "border-t border-white/[0.06]"}>
            {!monthOnly && <p className="px-3 pt-2 pb-1 text-[10px] text-gray-600 uppercase tracking-wider">Specific Month</p>}
            <div className="max-h-44 overflow-y-auto pb-1 px-1">
              {months12.map(({ year: y, month: m }) => {
                const isActive = value === "month" && selYear === y && selMonth === m;
                return (
                  <button
                    key={`${y}-${m}`}
                    onClick={() => { onSelect("month", y, m); setOpen(false); }}
                    className={`w-full text-left px-3 py-1.5 text-sm rounded-lg transition-colors ${
                      isActive
                        ? "bg-white/[0.08] text-white"
                        : "text-gray-400 hover:text-white hover:bg-white/[0.05]"
                    }`}
                  >
                    {MONTHS[m - 1]} {y}
                    {isActive && <span className="ml-2 text-emerald-400 text-xs">✓</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Creator picker ───────────────────────────────────────────────────────────

function CreatorPicker({
  creators, value, onChange,
}: {
  creators: CreatorRow[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const selected = creators.find(c => c.id === value);
  const label = selected ? selected.name : "All Creators";

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 bg-[#0d0d15]/80 border border-white/[0.14] hover:border-white/[0.28] rounded-lg px-3 py-2 text-sm text-gray-300 transition-all"
      >
        <Users size={13} className="text-gray-500" />
        <span>{label}</span>
        <ChevronDown size={12} className={`text-gray-500 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 bg-[#0b0b12]/95 backdrop-blur-2xl border border-white/[0.08] rounded-xl shadow-[0_20px_60px_rgba(0,0,0,0.8)] z-50 w-48 overflow-hidden">
          <div className="p-1">
            <button
              onClick={() => { onChange(null); setOpen(false); }}
              className={`w-full text-left px-3 py-2 text-sm rounded-lg transition-colors ${
                value === null ? "bg-white/[0.08] text-white" : "text-gray-400 hover:text-white hover:bg-white/[0.05]"
              }`}
            >
              All Creators
            </button>
          </div>
          <div className="border-t border-white/[0.06]">
            <div className="max-h-60 overflow-y-auto p-1">
              {creators.map(c => (
                <button
                  key={c.id}
                  onClick={() => { onChange(c.id); setOpen(false); }}
                  className={`w-full text-left px-3 py-2 text-sm rounded-lg transition-colors ${
                    value === c.id ? "bg-white/[0.08] text-white" : "text-gray-400 hover:text-white hover:bg-white/[0.05]"
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Post grid ────────────────────────────────────────────────────────────────

function PostGrid({ posts, tiktokUsername }: { posts: PostRow[]; tiktokUsername?: string | null }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
      {posts.map((p, i) => {
        const postUrl = p.platform === "instagram"
          ? `https://www.instagram.com/reel/${p.post_id}/`
          : p.platform === "tiktok" && tiktokUsername
          ? `https://www.tiktok.com/@${tiktokUsername}/video/${p.post_id}`
          : undefined;
        return (
          <a
            key={p.post_id}
            href={postUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group bg-[#0d0d15]/75 backdrop-blur-sm border border-white/[0.12] hover:border-white/[0.24] hover:bg-[#0d0d15]/90 rounded-xl overflow-hidden transition-all block hover:shadow-[0_4px_24px_rgba(0,0,0,0.5)]"
          >
            <div className="relative w-full aspect-[4/5] bg-[#0d0d15]">
              {p.thumbnail_url ? (
                <img
                  src={`/api/proxy-image?url=${encodeURIComponent(p.thumbnail_url)}`}
                  alt=""
                  className="w-full h-full object-cover group-hover:opacity-80 transition-opacity"
                  onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-700">
                  <FileVideo size={24} />
                </div>
              )}
              <span className={`absolute top-2 left-2 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                i === 0 ? "bg-yellow-500/90 text-black" :
                i === 1 ? "bg-gray-300/80 text-black" :
                i === 2 ? "bg-orange-600/80 text-white" :
                "bg-black/60 text-gray-300"
              }`}>{i + 1}</span>
              <span className="absolute bottom-2 left-2 text-[10px] px-1.5 py-0.5 rounded font-medium bg-black/60 text-gray-300">
                {p.taken_at
                  ? new Date(p.taken_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                  : "—"}
              </span>
              {postUrl && (
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30">
                  {p.platform === "tiktok"
                    ? <Music2 size={28} className="text-white drop-shadow" />
                    : <Instagram size={28} className="text-white drop-shadow" />
                  }
                </div>
              )}
            </div>
            <div className="p-3 space-y-1.5">
              <div className="flex justify-between items-center">
                <span className="text-gray-600 text-xs flex items-center gap-1"><Eye size={10}/> Views</span>
                <span className="text-white text-sm font-semibold">{fmt(p.view_count_used)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600 text-xs flex items-center gap-1"><Heart size={10}/> Likes</span>
                <span className="text-gray-300 text-xs font-medium">{p.like_count > 0 ? fmt(p.like_count) : "—"}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600 text-xs flex items-center gap-1"><MessageCircle size={10}/> Comments</span>
                <span className="text-gray-300 text-xs font-medium">{p.comment_count > 0 ? fmt(p.comment_count) : "—"}</span>
              </div>
            </div>
          </a>
        );
      })}
    </div>
  );
}

// ─── Home tab ─────────────────────────────────────────────────────────────────

function HomeTab({ creators }: { creators: CreatorRow[] }) {
  const now = new Date();
  const [rangeType, setRangeType] = useState<TimeRangeType>("30d");
  const [selYear,  setSelYear]  = useState(now.getFullYear());
  const [selMonth, setSelMonth] = useState(now.getMonth() + 1);
  const [summaries, setSummaries] = useState<RangeSummary[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);
  const [rangeApprox, setRangeApprox] = useState(false);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);
  const [creatorPosts, setCreatorPosts] = useState<PostRow[]>([]);
  const [allCreatorPosts, setAllCreatorPosts] = useState<Map<string, PostRow[]>>(new Map());
  const [postsLoading, setPostsLoading] = useState(false);
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [platformFilter, setPlatformFilter] = useState<"all" | "instagram" | "tiktok">("all");

  // Chart: daily deltas for rolling/month ranges; 12-month aggregates for all-time
  // For daily views, also fetch completed cycle end dates to overlay payout dot markers.
  useEffect(() => {
    const cParam = selectedCreatorId ? `&creator_id=${selectedCreatorId}` : "";
    if (rangeType === "all") {
      fetch(`/api/dashboard/chart?months=12${cParam}`)
        .then(r => r.json())
        .then(data => setChartData(Array.isArray(data) ? data : []));
      return;
    }
    const now = new Date();
    let chartUrl: string;
    let from: string;
    let to: string;
    if (rangeType === "7d" || rangeType === "14d" || rangeType === "30d") {
      const days = rangeType === "7d" ? 7 : rangeType === "14d" ? 14 : 30;
      chartUrl = `/api/dashboard/chart-range?days=${days}${cParam}`;
      const fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
      from = fromDate.toISOString().split("T")[0];
      to = now.toISOString().split("T")[0];
    } else {
      chartUrl = `/api/dashboard/chart-range?year=${selYear}&month=${selMonth}${cParam}`;
      const daysInMonth = new Date(selYear, selMonth, 0).getDate();
      from = `${selYear}-${String(selMonth).padStart(2, "0")}-01`;
      to = `${selYear}-${String(selMonth).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;
    }
    Promise.all([
      fetch(chartUrl).then(r => r.json()),
      fetch(`/api/dashboard/payout-events?from=${from}&to=${to}${cParam}`).then(r => r.json()),
    ]).then(([chartRaw, eventsRaw]) => {
      const events: PayoutEvent[] = Array.isArray(eventsRaw) ? eventsRaw : [];
      const points: { name: string; Views: number }[] = Array.isArray(chartRaw) ? chartRaw : [];
      const merged: ChartPoint[] = points.map(point => {
        const dayEvents = events.filter(e => {
          const [y, m, d] = e.date.split("-").map(Number);
          const label = new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
          return label === point.name;
        });
        return dayEvents.length > 0 ? { ...point, payoutEvents: dayEvents } : point;
      });
      setChartData(merged);
    });
  }, [rangeType, selYear, selMonth, selectedCreatorId]);

  // Stats: all-time from creators data; rolling windows from range API; month from cycles API
  useEffect(() => {
    setRangeApprox(false);
    if (rangeType === "all") {
      setStatsLoading(true);
      const cParam = selectedCreatorId ? `&creator_id=${selectedCreatorId}` : "";
      fetch(`/api/dashboard/range?days=1095${cParam}`)
        .then(r => r.json())
        .then(res => {
          setSummaries(Array.isArray(res.results) ? res.results : []);
          setRangeApprox(!res.windowAccurate);
          setStatsLoading(false);
        });
      return;
    }
    setStatsLoading(true);
    if (rangeType === "month") {
      fetch(`/api/dashboard/cycles?year=${selYear}&month=${selMonth}`)
        .then(r => r.json())
        .then((cycles: CycleRecord[]) => {
          const byCreator = new Map<string, RangeSummary>();
          for (const c of (Array.isArray(cycles) ? cycles : [])) {
            // Base fee only counts when the cycle is complete (pending/paid), not while in-progress
            const contribution = c.status === "in_progress" ? c.view_bonus : c.payout_amount;
            const existing = byCreator.get(c.creator_id);
            if (existing) {
              existing.total_views += c.views_earned;
              existing.payout += contribution;
            } else {
              byCreator.set(c.creator_id, {
                id: c.creator_id, name: c.creator_name,
                instagram_username: c.instagram_username, tiktok_username: c.tiktok_username,
                ig_views: 0, tt_views: 0, total_views: c.views_earned,
                ig_posts: 0, tt_posts: 0, total_posts: 0, payout: contribution,
              });
            }
          }
          setSummaries(Array.from(byCreator.values()));
          setStatsLoading(false);
        });
    } else {
      const days = rangeType === "7d" ? 7 : rangeType === "14d" ? 14 : 30;
      fetch(`/api/dashboard/range?days=${days}`)
        .then(r => r.json())
        .then(res => {
          setSummaries(Array.isArray(res.results) ? res.results : []);
          setRangeApprox(!res.windowAccurate);
          setStatsLoading(false);
        });
    }
  }, [rangeType, selYear, selMonth, creators]);

  function handleRangeSelect(type: TimeRangeType, year?: number, month?: number) {
    setRangeType(type);
    if (year !== undefined) setSelYear(year);
    if (month !== undefined) setSelMonth(month);
  }

  useEffect(() => {
    setPostsLoading(true);
    if (selectedCreatorId) {
      fetch(`/api/posts/${selectedCreatorId}`)
        .then(r => r.json())
        .then(data => {
          const sorted = (Array.isArray(data) ? data : [])
            .sort((a: PostRow, b: PostRow) => b.view_count_used - a.view_count_used);
          setCreatorPosts(sorted);
          setPostsLoading(false);
        });
    } else {
      Promise.all(
        creators.filter(c => c.active).map(c =>
          fetch(`/api/posts/${c.id}`)
            .then(r => r.json())
            .then((data: PostRow[]) => ({
              id: c.id,
              posts: (Array.isArray(data) ? data : [])
                .sort((a, b) => b.view_count_used - a.view_count_used),
            }))
        )
      ).then(results => {
        const map = new Map<string, PostRow[]>();
        for (const r of results) map.set(r.id, r.posts);
        setAllCreatorPosts(map);
        setPostsLoading(false);
      });
    }
  }, [selectedCreatorId, creators]);

  const filteredSummaries = selectedCreatorId ? summaries.filter(s => s.id === selectedCreatorId) : summaries;
  const filteredCreators  = selectedCreatorId ? creators.filter(c => c.id === selectedCreatorId) : creators;

  const totalViews  = filteredSummaries.reduce((s, x) => s + x.total_views, 0);
  const igTotal     = filteredSummaries.reduce((s, x) => s + x.ig_views, 0);
  const ttTotal     = filteredSummaries.reduce((s, x) => s + x.tt_views, 0);
  const totalPayout = filteredSummaries.reduce((s, x) => s + x.payout, 0);
  const displayViews = platformFilter === "instagram" ? igTotal : platformFilter === "tiktok" ? ttTotal : totalViews;
  const cpm = totalViews > 0 ? (totalPayout / totalViews) * 1000 : 0;

  function filterPostsByRange(posts: PostRow[]): PostRow[] {
    const now = new Date();
    let from: Date | null = null;
    let to: Date | null = null;
    if (rangeType === "7d")  from = new Date(now.getTime() -  7 * 86400000);
    if (rangeType === "14d") from = new Date(now.getTime() - 14 * 86400000);
    if (rangeType === "30d") from = new Date(now.getTime() - 30 * 86400000);
    if (rangeType === "month") {
      from = new Date(selYear, selMonth - 1, 1);
      to   = new Date(selYear, selMonth, 1);
    }
    if (!from) return posts;
    return posts.filter(p => {
      if (!p.taken_at) return false;
      const d = new Date(p.taken_at);
      if (from && d < from) return false;
      if (to && d >= to) return false;
      return true;
    });
  }

  function filterPostsByRangeAndPlatform(posts: PostRow[]): PostRow[] {
    const filtered = filterPostsByRange(posts);
    if (platformFilter === "all") return filtered;
    return filtered.filter(p => p.platform === platformFilter);
  }

  const displayCreatorPosts = filterPostsByRangeAndPlatform(creatorPosts).slice(0, 8);

  // Total Posts: counted from post_snapshots filtered by taken_at — accurate regardless of sync frequency
  const activeCreators = filteredCreators.filter(c => c.active);
  const totalPosts = selectedCreatorId
    ? filterPostsByRangeAndPlatform(creatorPosts).length
    : activeCreators.reduce((sum, c) => sum + filterPostsByRangeAndPlatform(allCreatorPosts.get(c.id) ?? []).length, 0);

  const periodLabel =
    rangeType === "all"   ? "all time" :
    rangeType === "month" ? `${MONTHS[selMonth - 1]} ${selYear}` :
    `last ${rangeType.replace("d", " days")}`;

  return (
    <div className="p-6 space-y-5">
      {/* Filters bar */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-600">
          {rangeType === "7d"  ? "Last 7 days" :
           rangeType === "14d" ? "Last 14 days" :
           rangeType === "30d" ? "Last 30 days" :
           rangeType === "all" ? "All time" :
           `${MONTHS[selMonth - 1]} ${selYear}`}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPlatformFilter(p => p === "instagram" ? "all" : "instagram")}
            title="Instagram only"
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors border ${
              platformFilter === "instagram"
                ? "bg-blue-500/15 text-blue-400 border-blue-500/30 shadow-[0_0_10px_rgba(96,165,250,0.12)]"
                : "bg-white/[0.05] text-gray-600 border-white/[0.1] hover:text-gray-300 hover:border-white/[0.13] hover:bg-white/[0.05]"
            }`}
          >
            <Instagram size={14}/>
          </button>
          <button
            onClick={() => setPlatformFilter(p => p === "tiktok" ? "all" : "tiktok")}
            title="TikTok only"
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors border ${
              platformFilter === "tiktok"
                ? "bg-pink-500/15 text-pink-400 border-pink-500/30 shadow-[0_0_10px_rgba(236,72,153,0.12)]"
                : "bg-white/[0.05] text-gray-600 border-white/[0.1] hover:text-gray-300 hover:border-white/[0.13] hover:bg-white/[0.05]"
            }`}
          >
            <Music2 size={14}/>
          </button>
          <CreatorPicker
            creators={creators}
            value={selectedCreatorId}
            onChange={setSelectedCreatorId}
          />
          <TimeRangePicker
            value={rangeType}
            selYear={selYear}
            selMonth={selMonth}
            onSelect={handleRangeSelect}
            showAll
          />
        </div>
      </div>

      {/* 4 stat cards */}
      <div className={`grid grid-cols-2 md:grid-cols-4 gap-3 transition-opacity ${statsLoading ? "opacity-50" : ""}`}>
        <Stat label={platformFilter === "instagram" ? "Instagram Views" : platformFilter === "tiktok" ? "TikTok Views" : "Total Views"} value={fmt(displayViews)} Icon={Eye} sub={rangeApprox ? "approx · sync daily for accuracy" : platformFilter !== "all" ? periodLabel : (ttTotal > 0 ? `IG ${fmt(igTotal)} · TT ${fmt(ttTotal)}` : periodLabel)} />
        <Stat label="Total Payouts" value={fmtMoney(totalPayout)} Icon={DollarSign} accent />
        <Stat label="CPM"          value={`$${cpm.toFixed(2)}`}  Icon={TrendingUp} sub="Cost per 1K views" />
        <Stat label="Total Posts"  value={String(totalPosts)}    Icon={FileVideo} />
      </div>

      {/* Views over time — full width */}
      <div className="bg-[#0d0d15]/80 backdrop-blur-xl border border-white/[0.14] rounded-xl p-5 shadow-[0_8px_32px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.14)]">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-semibold text-gray-200">Views Over Time</h2>
          <span className="text-xs text-gray-600">
            {rangeType === "all"   ? "Last 12 months" :
             rangeType === "month" ? `${MONTHS[selMonth - 1]} ${selYear} · daily` :
             `Last ${rangeType.replace("d", " days")} · daily`}
            {!selectedCreatorId ? " · all creators" : ""}
          </span>
        </div>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={chartData} margin={{ top: 24, right: 5, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="gViews" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#34d399" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#34d399" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis
              dataKey="name"
              tick={{ fill: "#6b7280", fontSize: 11 }}
              axisLine={false} tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fill: "#6b7280", fontSize: 11 }}
              axisLine={false} tickLine={false}
              tickFormatter={v => fmt(v as number)}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const point = payload[0]?.payload as ChartPoint;
                return (
                  <div style={{ backgroundColor: "rgba(10,10,18,0.95)", backdropFilter: "blur(12px)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "8px 12px", fontSize: "12px", lineHeight: "1.6" }}>
                    <p style={{ color: "#9ca3af", marginBottom: "2px" }}>{label}</p>
                    <p style={{ color: "#e5e7eb" }}>{fmt(point.Views)} views</p>
                    {point.payoutEvents?.map((evt, i) => (
                      <div key={i} style={{ marginTop: "8px", borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: "8px" }}>
                        <p style={{ color: "#34d399", fontWeight: 600, marginBottom: "2px" }}>Cycle complete · {evt.creator_name}</p>
                        <p style={{ color: "#9ca3af" }}>
                          {new Date(evt.cycle_start_date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                          {" → "}
                          {new Date(evt.cycle_end_date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        </p>
                        <p style={{ color: "#9ca3af" }}>Base rate: ${evt.base_fee}/mo</p>
                      </div>
                    ))}
                  </div>
                );
              }}
            />
            <Area
              type="monotone"
              dataKey="Views"
              stroke="#34d399"
              fill="url(#gViews)"
              strokeWidth={2}
              dot={(props: any) => {
                if (!props.payload?.payoutEvents?.length) return <g />;
                return (
                  <circle
                    cx={props.cx}
                    cy={props.cy}
                    r={5}
                    fill="#34d399"
                    stroke="rgba(10,10,18,0.95)"
                    strokeWidth={2.5}
                  />
                );
              }}
              activeDot={{ r: 4, fill: "#34d399", strokeWidth: 0 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Posts section */}
      {postsLoading ? (
        <div className="bg-[#0d0d15]/80 backdrop-blur-xl border border-white/[0.14] rounded-xl p-10 text-center text-gray-600 text-sm">Loading...</div>
      ) : selectedCreatorId ? (
        /* ── Single creator: top 8 grid ── */
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-200">
              Top Posts
              <span className="text-gray-600 font-normal ml-2">· {creators.find(c => c.id === selectedCreatorId)?.name}</span>
            </h2>
            <span className="text-xs text-gray-600">Top 8 · {periodLabel}</span>
          </div>
          {displayCreatorPosts.length === 0 ? (
            <div className="bg-[#0d0d15]/80 backdrop-blur-xl border border-white/[0.14] rounded-xl p-10 text-center text-gray-600 text-sm">
              {creatorPosts.length === 0 ? "No posts synced yet" : `No posts in this period`}
            </div>
          ) : (
            <PostGrid posts={displayCreatorPosts} tiktokUsername={creators.find(c => c.id === selectedCreatorId)?.tiktok_username} />
          )}
        </div>
      ) : (
        /* ── All creators: one section per creator ── */
        <div className="space-y-6">
          {[...filteredCreators].filter(c => c.active)
            .sort((a, b) => {
              const aTop = (allCreatorPosts.get(a.id)?.[0]?.view_count_used ?? 0);
              const bTop = (allCreatorPosts.get(b.id)?.[0]?.view_count_used ?? 0);
              return bTop - aTop;
            })
            .map(creator => {
              const allPosts = allCreatorPosts.get(creator.id) ?? [];
              const posts = filterPostsByRangeAndPlatform(allPosts).slice(0, 4);
              return (
                <div key={creator.id}>
                  <div className="flex items-center gap-3 mb-3">
                    <h2 className="text-sm font-semibold text-gray-200">{creator.name}</h2>
                    {creator.instagram_username && (
                      <span className="text-blue-400/60 text-xs flex items-center gap-1">
                        <Instagram size={10}/> @{creator.instagram_username}
                      </span>
                    )}
                    {creator.tiktok_username && (
                      <span className="text-pink-400/60 text-xs flex items-center gap-1">
                        <Music2 size={10}/> @{creator.tiktok_username}
                      </span>
                    )}
                    <span className="text-xs text-gray-600 ml-auto">Top 4 · {periodLabel}</span>
                  </div>
                  {posts.length === 0 ? (
                    <div className="bg-[#0d0d15]/80 backdrop-blur-xl border border-white/[0.14] rounded-xl p-6 text-center text-gray-600 text-sm">
                      {allPosts.length === 0 ? "No posts synced yet" : "No posts in this period"}
                    </div>
                  ) : (
                    <PostGrid posts={posts} tiktokUsername={creator.tiktok_username} />
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

// ─── Creators tab ─────────────────────────────────────────────────────────────

type CreatorSortKey = "name" | "views" | "posts" | "payout" | "joined_at" | "status";

function CreatorsTab({
  creators, syncing, onSync, onAdd, onNavigate, onRefresh,
}: {
  creators: CreatorRow[];
  syncing: string | null;
  onSync: (id: string) => void;
  onAdd: () => void;
  onNavigate: (id: string) => void;
  onRefresh: () => void;
}) {
  const [sortKey, setSortKey] = useState<CreatorSortKey>("status");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [editingCreator, setEditingCreator] = useState<CreatorRow | null>(null);

  function handleSort(key: CreatorSortKey) {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir(key === "name" || key === "joined_at" || key === "status" ? "asc" : "desc"); }
  }

  const rows = creators.map(c => ({ creator: c, ...getAllTimeSummary(c) }));

  const sorted = [...rows].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case "name":      cmp = a.creator.name.localeCompare(b.creator.name); break;
      case "views":     cmp = a.allViews - b.allViews; break;
      case "posts":     cmp = a.allPosts - b.allPosts; break;
      case "payout":    cmp = a.totalPayout - b.totalPayout; break;
      case "joined_at": cmp = (a.creator.joined_at ?? "").localeCompare(b.creator.joined_at ?? ""); break;
      case "status":    cmp = (a.creator.active ? 0 : 1) - (b.creator.active ? 0 : 1); break;
    }
    return sortDir === "asc" ? cmp : -cmp;
  });

  function ColHeader({
    col, label, right = false,
  }: { col: CreatorSortKey; label: string; right?: boolean }) {
    const active = sortKey === col;
    return (
      <th
        onClick={() => handleSort(col)}
        className={`px-4 py-3 cursor-pointer select-none text-xs transition-colors ${right ? "text-right" : "text-left"}`}
      >
        <span className={`inline-flex items-center gap-1 ${right ? "justify-end" : ""} ${active ? "text-white" : "text-gray-500 hover:text-gray-300"}`}>
          {label}
          {active
            ? <span className="text-emerald-400">{sortDir === "asc" ? "↑" : "↓"}</span>
            : <ArrowUpDown size={10} className="text-gray-700"/>
          }
        </span>
      </th>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{creators.length} creators</p>
        <button
          onClick={onAdd}
          className="flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-black font-semibold px-4 py-2 rounded-lg text-sm transition-all shadow-[0_0_20px_rgba(52,211,153,0.2)] hover:shadow-[0_0_30px_rgba(52,211,153,0.4)]"
        >
          <Plus size={14}/> Add Creator
        </button>
      </div>

      <div className="bg-[#0d0d15]/80 backdrop-blur-xl border border-white/[0.14] rounded-xl overflow-hidden shadow-[0_8px_32px_rgba(0,0,0,0.6)]">
        {creators.length === 0 ? (
          <div className="py-16 text-center text-gray-600">
            No creators yet.{" "}
            <button onClick={onAdd} className="text-emerald-400 hover:underline">Add one</button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.07]">
                  <ColHeader col="name"      label="Creator" />
                  <th className="text-left px-4 py-3 text-xs text-gray-500">Deal</th>
                  <ColHeader col="posts"     label="All-Time Posts"  right />
                  <ColHeader col="views"     label="All-Time Views"  right />
                  <ColHeader col="payout"    label="Total Paid"      right />
                  <ColHeader col="joined_at" label="Joined"          right />
                  <ColHeader col="status"    label="Status" />
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(({ creator, allViews, allPosts, totalPayout }) => (
                  <tr
                    key={creator.id}
                    onClick={() => onNavigate(creator.id)}
                    className="border-b border-white/[0.04] hover:bg-white/[0.03] cursor-pointer transition-colors"
                  >
                    {/* Creator */}
                    <td className="px-5 py-4">
                      <div className="font-medium text-white">{creator.name}</div>
                      {creator.instagram_username && (
                        <div className="text-blue-400/60 text-xs flex items-center gap-0.5 mt-0.5">
                          <Instagram size={9}/> @{creator.instagram_username}
                        </div>
                      )}
                      {creator.tiktok_username && (
                        <div className="text-pink-400/60 text-xs flex items-center gap-0.5 mt-0.5">
                          <Music2 size={9}/> @{creator.tiktok_username}
                        </div>
                      )}
                    </td>

                    {/* Deal */}
                    <td className="px-4 py-4">
                      <div className="text-gray-300 text-xs font-medium">${creator.base_fee}/mo</div>
                      <div className="text-gray-600 text-xs mt-0.5">
                        ${creator.rate_per_thousand_views}/1K · {creator.affiliate_percentage ?? 0}% aff
                      </div>
                    </td>

                    {/* All-time posts */}
                    <td className="px-4 py-4 text-right font-medium text-white tabular-nums">
                      {allPosts.toLocaleString()}
                    </td>

                    {/* All-time views */}
                    <td className="px-4 py-4 text-right font-medium text-white tabular-nums">
                      {fmt(allViews)}
                    </td>

                    {/* Total paid */}
                    <td className="px-4 py-4 text-right font-semibold text-emerald-400 tabular-nums">
                      ${totalPayout.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>

                    {/* Joined */}
                    <td className="px-4 py-4 text-right text-gray-500 text-xs tabular-nums">
                      {fmtDate(creator.joined_at)}
                    </td>

                    {/* Status */}
                    <td className="px-4 py-4">
                      <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full font-medium ${
                        creator.active
                          ? "bg-emerald-500/10 text-emerald-400"
                          : "bg-yellow-500/10 text-yellow-400"
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${creator.active ? "bg-emerald-400" : "bg-yellow-400"}`}/>
                        {creator.active ? "Active" : "Paused"}
                      </span>
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-2 justify-end">
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditingCreator(creator); }}
                          className="text-gray-600 hover:text-white transition-colors"
                          title="Quick edit"
                        >
                          <Pencil size={13}/>
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); onSync(creator.id); }}
                          disabled={syncing === creator.id}
                          className="text-gray-600 hover:text-white transition-colors disabled:opacity-40"
                          title="Sync data"
                        >
                          <RefreshCw size={13} className={syncing === creator.id ? "animate-spin" : ""}/>
                        </button>
                        <ChevronRight size={13} className="text-gray-700"/>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editingCreator && (
        <QuickEditModal
          creator={editingCreator}
          onClose={() => setEditingCreator(null)}
          onSaved={() => { setEditingCreator(null); onRefresh(); }}
        />
      )}
    </div>
  );
}

// ─── Payouts tab ──────────────────────────────────────────────────────────────

function PayoutsTab() {
  const now = new Date();
  const [selYear,  setSelYear]  = useState(now.getFullYear());
  const [selMonth, setSelMonth] = useState(now.getMonth() + 1);
  const [cycles,   setCycles]   = useState<CycleRecord[]>([]);
  const [fetching, setFetching] = useState(false);
  const [marking,  setMarking]  = useState<string | null>(null);

  useEffect(() => {
    setFetching(true);
    fetch(`/api/dashboard/cycles?year=${selYear}&month=${selMonth}`)
      .then(r => r.json())
      .then(data => {
        setCycles(Array.isArray(data) ? data : []);
        setFetching(false);
      });
  }, [selYear, selMonth]);

  async function handleMarkPaid(cycleId: string) {
    setMarking(cycleId);
    await fetch(`/api/payout-cycles/${cycleId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paid" }),
    });
    setCycles(prev => prev.map(c => c.id === cycleId ? { ...c, status: "paid" as const } : c));
    setMarking(null);
  }

  function handleMonthSelect(_type: TimeRangeType, year?: number, month?: number) {
    if (year  !== undefined) setSelYear(year);
    if (month !== undefined) setSelMonth(month);
  }

  const grandTotal   = cycles.reduce((s, c) => s + c.payout_amount, 0);
  const grandViews   = cycles.reduce((s, c) => s + c.views_earned, 0);
  const pendingTotal = cycles.filter(c => c.status === "pending").reduce((s, c) => s + c.payout_amount, 0);

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-600">Total Payout · {MONTHS[selMonth - 1]} {selYear}</p>
          <p className="text-xl font-bold text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.4)]">{fmtMoney(grandTotal)}</p>
          {pendingTotal > 0 && (
            <p className="text-xs text-yellow-500 mt-0.5">{fmtMoney(pendingTotal)} pending</p>
          )}
        </div>
        <TimeRangePicker
          value="month"
          selYear={selYear}
          selMonth={selMonth}
          onSelect={handleMonthSelect}
          monthOnly
        />
      </div>

      {/* Table */}
      <div className={`bg-[#0d0d15]/80 backdrop-blur-xl border border-white/[0.14] rounded-xl overflow-hidden shadow-[0_8px_32px_rgba(0,0,0,0.6)] transition-opacity ${fetching ? "opacity-50" : ""}`}>
        {cycles.length === 0 && !fetching ? (
          <div className="py-16 text-center text-gray-600 text-sm">
            No cycles ending in {MONTHS[selMonth - 1]} {selYear}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.07]">
                  <th className="text-left px-5 py-3 text-xs text-gray-500">Creator</th>
                  <th className="text-left px-4 py-3 text-xs text-gray-500">Cycle Period</th>
                  <th className="text-right px-4 py-3 text-xs text-gray-500">Views Earned</th>
                  <th className="text-right px-4 py-3 text-xs text-gray-500">Base Fee</th>
                  <th className="text-right px-4 py-3 text-xs text-gray-500">View Bonus</th>
                  <th className="text-right px-4 py-3 text-xs text-gray-500">Total</th>
                  <th className="text-left px-4 py-3 text-xs text-gray-500">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {cycles.map(cycle => (
                  <tr key={cycle.id} className="border-b border-white/[0.04] hover:bg-white/[0.03]">
                    {/* Creator */}
                    <td className="px-5 py-3.5">
                      <div className="font-medium text-white">{cycle.creator_name}</div>
                      {cycle.instagram_username && (
                        <div className="text-blue-400/60 text-xs flex items-center gap-0.5 mt-0.5">
                          <Instagram size={9} /> @{cycle.instagram_username}
                        </div>
                      )}
                    </td>
                    {/* Cycle period */}
                    <td className="px-4 py-3.5 text-gray-400 text-xs tabular-nums whitespace-nowrap">
                      {new Date(cycle.cycle_start_date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      {" → "}
                      {new Date(cycle.cycle_end_date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </td>
                    {/* Views */}
                    <td className="px-4 py-3.5 text-right text-gray-200 tabular-nums">{fmt(cycle.views_earned)}</td>
                    {/* Base fee */}
                    <td className="px-4 py-3.5 text-right text-gray-400 tabular-nums">${cycle.base_fee.toFixed(2)}</td>
                    {/* View bonus */}
                    <td className="px-4 py-3.5 text-right text-gray-400 tabular-nums">${cycle.view_bonus.toFixed(2)}</td>
                    {/* Total */}
                    <td className="px-4 py-3.5 text-right font-semibold text-emerald-400 tabular-nums">${cycle.payout_amount.toFixed(2)}</td>
                    {/* Status */}
                    <td className="px-4 py-3.5">
                      {cycle.status === "paid" && (
                        <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full font-medium bg-emerald-500/10 text-emerald-400">
                          <CheckCircle2 size={10} /> Paid
                        </span>
                      )}
                      {cycle.status === "pending" && (
                        <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full font-medium bg-yellow-500/10 text-yellow-400">
                          <Clock size={10} /> Pending
                        </span>
                      )}
                      {cycle.status === "in_progress" && (
                        <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full font-medium bg-gray-500/10 text-gray-500">
                          <TrendingUp size={10} /> In Progress
                        </span>
                      )}
                    </td>
                    {/* Mark Paid */}
                    <td className="px-4 py-3.5">
                      {cycle.status === "pending" && (
                        <button
                          onClick={() => handleMarkPaid(cycle.id)}
                          disabled={marking === cycle.id}
                          className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 transition-colors disabled:opacity-50"
                        >
                          <CheckCircle2 size={11} />
                          {marking === cycle.id ? "..." : "Mark Paid"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-white/[0.07] bg-white/[0.02]">
                  <td className="px-5 py-3.5 font-semibold text-gray-300" colSpan={2}>
                    {MONTHS[selMonth - 1]} {selYear} · Totals
                  </td>
                  <td className="px-4 py-3.5 text-right font-semibold text-white tabular-nums">
                    {fmt(grandViews)}
                  </td>
                  <td colSpan={2} />
                  <td className="px-4 py-3.5 text-right font-bold text-emerald-400 tabular-nums">
                    {fmtMoney(grandTotal)}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const now = new Date();

  const [activeTab, setActiveTab] = useState<Tab>("home");
  const [creators, setCreators] = useState<CreatorRow[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [syncing,  setSyncing]  = useState<string | null>(null);
  const [showAdd,  setShowAdd]  = useState(false);

  const fetchCreators = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/creators");
      const data = await res.json();
      setCreators(Array.isArray(data) ? data : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchCreators(); }, [fetchCreators]);

  async function syncCreator(id: string) {
    setSyncing(id);
    await fetch(`/api/sync/${id}`, { method: "POST" });
    await fetchCreators();
    setSyncing(null);
  }

  return (
    <div className="flex min-h-screen text-white">
      <Sidebar active={activeTab} onChange={setActiveTab} />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Top header bar */}
        <div className="border-b border-white/[0.08] px-6 py-3.5 flex items-center justify-between shrink-0 bg-[#07070e]/70 backdrop-blur-2xl">
          <div>
            <h1 className="text-sm font-semibold text-white capitalize">{activeTab}</h1>
            <p className="text-gray-700 text-xs">{creators.filter(c => c.active).length} active creators</p>
          </div>
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-gray-700 text-sm">Loading...</div>
        ) : (
          <>
            {activeTab === "home" && <HomeTab creators={creators} />}
            {activeTab === "creators" && (
              <CreatorsTab
                creators={creators}
                syncing={syncing}
                onSync={syncCreator}
                onAdd={() => setShowAdd(true)}
                onNavigate={(id) => router.push(`/creators/${id}`)}
                onRefresh={fetchCreators}
              />
            )}
            {activeTab === "payouts" && <PayoutsTab />}
          </>
        )}
      </div>

      {showAdd && (
        <AddCreatorModal onClose={() => setShowAdd(false)} onCreated={fetchCreators} />
      )}
    </div>
  );
}

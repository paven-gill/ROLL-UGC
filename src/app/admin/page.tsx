"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Plus, Building2, UserPlus, KeyRound, Wallet, Pencil, Trash2, Check, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { createBrowserAuthClient } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";

interface Campaign {
  id: string;
  name: string;
  slug: string | null;
}
interface AdminUser {
  id: string;
  email: string | null;
  role: "super_admin" | "brand_admin";
  campaign_id: string | null;
  campaign_name: string | null;
}

const card = "rounded-xl border border-white/[0.08] bg-white/[0.02] p-5";
const inputCls =
  "flex-1 rounded-lg border border-white/[0.1] bg-white/[0.05] px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500/50";
const btn =
  "flex items-center gap-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-3 py-2 text-sm hover:bg-emerald-500/20 disabled:opacity-50";

// ─── Change password (everyone) ──────────────────────────────────────────────
function ChangePasswordSection() {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (pw.length < 8) return setMsg("Password must be at least 8 characters.");
    if (pw !== pw2) return setMsg("Passwords don't match.");
    setBusy(true);
    const { error } = await createBrowserAuthClient().auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return setMsg(error.message);
    setPw("");
    setPw2("");
    setMsg("Password updated.");
  }

  return (
    <section className={card}>
      <h2 className="flex items-center gap-2 text-sm font-medium mb-4">
        <KeyRound size={15} className="text-emerald-400" /> Change password
      </h2>
      <form onSubmit={submit} className="flex flex-col sm:flex-row gap-2">
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="New password"
          className={inputCls}
        />
        <input
          type="password"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
          placeholder="Confirm password"
          className={inputCls}
        />
        <button type="submit" disabled={busy} className={btn}>
          Update
        </button>
      </form>
      {msg && <p className="text-xs text-gray-400 mt-3">{msg}</p>}
    </section>
  );
}

// ─── A single user row with edit (reassign / reset pw) + delete ──────────────
function UserRow({
  user,
  isOwner,
  campaigns,
  onChanged,
}: {
  user: AdminUser;
  isOwner: boolean;
  campaigns: Campaign[];
  onChanged: () => void | Promise<void>;
}) {
  const { userId } = useAuth();
  const isSelf = user.id === userId;
  const isOwnerRow = user.role === "super_admin";
  const [editing, setEditing] = useState(false);
  const [campaign, setCampaign] = useState(user.campaign_id ?? "");
  const [tempPw, setTempPw] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function saveCampaign() {
    setBusy(true);
    setMsg(null);
    const res = await apiFetch(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ campaign_id: campaign || null }),
    });
    setBusy(false);
    if (!res.ok) return setMsg((await res.json()).error ?? "Failed");
    setEditing(false);
    await onChanged();
  }

  async function resetPassword() {
    setBusy(true);
    setMsg(null);
    const res = await apiFetch(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resetPassword: true }),
    });
    setBusy(false);
    const data = await res.json();
    if (!res.ok) return setMsg(data.error ?? "Failed");
    setTempPw(data.tempPassword);
  }

  async function remove() {
    if (!confirm(`Delete ${user.email}? This removes their login permanently.`)) return;
    setBusy(true);
    const res = await apiFetch(`/api/admin/users/${user.id}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) return setMsg((await res.json()).error ?? "Failed");
    await onChanged();
  }

  return (
    <div className="text-sm px-3 py-2 rounded-lg bg-white/[0.03]">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate">{user.email}{isSelf && <span className="text-gray-600"> (you)</span>}</span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-gray-500 text-xs">
            {isOwnerRow ? "Owner (all brands)" : user.campaign_name ?? "Manager"}
          </span>
          {!isOwnerRow && (
            <button onClick={() => setEditing((v) => !v)} className="text-gray-600 hover:text-white" title="Edit">
              <Pencil size={13} />
            </button>
          )}
          {!isSelf && !isOwnerRow && (
            <button onClick={remove} disabled={busy} className="text-gray-600 hover:text-red-400" title="Delete">
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-3 pt-3 border-t border-white/[0.06] space-y-3">
          {isOwner && (
            <div className="flex items-center gap-2">
              <select
                value={campaign}
                onChange={(e) => setCampaign(e.target.value)}
                className="flex-1 rounded-lg border border-white/[0.1] bg-white/[0.05] px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50"
              >
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <button onClick={saveCampaign} disabled={busy} className="text-emerald-400 hover:text-emerald-300" title="Save campaign">
                <Check size={16} />
              </button>
              <button onClick={() => { setEditing(false); setCampaign(user.campaign_id ?? ""); }} className="text-gray-500 hover:text-white" title="Cancel">
                <X size={16} />
              </button>
            </div>
          )}
          <button onClick={resetPassword} disabled={busy} className="text-xs text-gray-300 hover:text-white underline underline-offset-2">
            Reset password
          </button>
          {tempPw && (
            <p className="text-xs font-mono">
              <span className="text-gray-500">New temp password: </span>
              <span className="text-emerald-300 select-all">{tempPw}</span>
            </p>
          )}
          {msg && <p className="text-xs text-red-400">{msg}</p>}
        </div>
      )}
      {!editing && msg && <p className="text-xs text-red-400 mt-2">{msg}</p>}
    </div>
  );
}

// ─── Team (Owner: all users + assign; Manager: own campaign only) ─────────────
function TeamSection({ isOwner }: { isOwner: boolean }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [email, setEmail] = useState("");
  const [campaign, setCampaign] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [created, setCreated] = useState<{ email: string; tempPassword: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const reqs: Promise<Response>[] = [apiFetch("/api/admin/users")];
    if (isOwner) reqs.push(apiFetch("/api/admin/campaigns"));
    const [u, c] = await Promise.all(reqs.map((p) => p.then((r) => (r.ok ? r.json() : []))));
    setUsers(Array.isArray(u) ? u : []);
    if (isOwner) setCampaigns(Array.isArray(c) ? c : []);
  }, [isOwner]);

  useEffect(() => { load(); }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    if (isOwner && !campaign) return setMsg("Pick a campaign for this user.");
    setBusy(true);
    setMsg(null);
    setCreated(null);
    const res = await apiFetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Manager: campaign/role are ignored server-side (forced to their own campaign).
      body: JSON.stringify({ email: email.trim(), campaign_id: campaign || undefined, role: "brand_admin" }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) return setMsg(data.error ?? "Failed to add user");
    setEmail("");
    setCreated({ email: data.email, tempPassword: data.tempPassword });
    await load();
  }

  return (
    <section className={card}>
      <h2 className="flex items-center gap-2 text-sm font-medium mb-4">
        <UserPlus size={15} className="text-emerald-400" /> {isOwner ? "Admins" : "Team"}
      </h2>
      <div className="space-y-1.5 mb-4">
        {users.map((u) => (
          <UserRow key={u.id} user={u} isOwner={isOwner} campaigns={campaigns} onChanged={load} />
        ))}
        {users.length === 0 && <p className="text-gray-600 text-sm">No one yet.</p>}
      </div>

      <form onSubmit={add} className="flex flex-col sm:flex-row gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@brand.com"
          className={inputCls}
        />
        {isOwner && (
          <select value={campaign} onChange={(e) => setCampaign(e.target.value)} className={inputCls + " sm:flex-none"}>
            <option value="">Assign campaign…</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
        <button type="submit" disabled={busy} className={btn}>
          <UserPlus size={14} /> Add
        </button>
      </form>

      {created && (
        <div className="mt-4 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.06] p-4">
          <p className="text-sm text-emerald-300 font-medium mb-2">Created — share these credentials</p>
          <div className="space-y-1 text-sm font-mono">
            <div className="flex justify-between gap-3"><span className="text-gray-500">Email</span><span className="text-white">{created.email}</span></div>
            <div className="flex justify-between gap-3"><span className="text-gray-500">Temp password</span><span className="text-white select-all">{created.tempPassword}</span></div>
          </div>
          <p className="text-gray-500 text-xs mt-3">Shown once. They can change it from their own Manage page.</p>
        </div>
      )}
      {msg && <p className="text-xs text-gray-400 mt-3">{msg}</p>}
    </section>
  );
}

// ─── A single campaign row with rename + delete ──────────────────────────────
function CampaignRow({ campaign, onChanged }: { campaign: Campaign; onChanged: () => void | Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(campaign.name);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function rename() {
    if (!name.trim()) return;
    setBusy(true);
    setMsg(null);
    const res = await apiFetch(`/api/admin/campaigns/${campaign.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    setBusy(false);
    if (!res.ok) return setMsg((await res.json()).error ?? "Failed");
    setEditing(false);
    await onChanged();
  }

  async function remove() {
    if (!confirm(`Delete campaign "${campaign.name}"?`)) return;
    setBusy(true);
    setMsg(null);
    const res = await apiFetch(`/api/admin/campaigns/${campaign.id}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) return setMsg((await res.json()).error ?? "Failed");
    await onChanged();
  }

  return (
    <div className="text-sm px-3 py-2 rounded-lg bg-white/[0.03]">
      <div className="flex items-center justify-between gap-2">
        {editing ? (
          <div className="flex items-center gap-2 flex-1">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 rounded-lg border border-white/[0.1] bg-white/[0.05] px-2 py-1 text-sm text-white focus:outline-none focus:border-emerald-500/50"
            />
            <button onClick={rename} disabled={busy} className="text-emerald-400 hover:text-emerald-300" title="Save"><Check size={16} /></button>
            <button onClick={() => { setEditing(false); setName(campaign.name); }} className="text-gray-500 hover:text-white" title="Cancel"><X size={16} /></button>
          </div>
        ) : (
          <>
            <span>{campaign.name}</span>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-gray-600 text-xs">{campaign.slug}</span>
              <button onClick={() => setEditing(true)} className="text-gray-600 hover:text-white" title="Rename"><Pencil size={13} /></button>
              <button onClick={remove} disabled={busy} className="text-gray-600 hover:text-red-400" title="Delete"><Trash2 size={13} /></button>
            </div>
          </>
        )}
      </div>
      {msg && <p className="text-xs text-red-400 mt-2">{msg}</p>}
    </div>
  );
}

// ─── Owner: create campaigns ──────────────────────────────────────────────────
function CampaignsSection() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const c = await apiFetch("/api/admin/campaigns").then((r) => (r.ok ? r.json() : []));
    setCampaigns(Array.isArray(c) ? c : []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setMsg(null);
    const res = await apiFetch("/api/admin/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    setBusy(false);
    if (!res.ok) return setMsg((await res.json()).error ?? "Failed to create campaign");
    setName("");
    await load();
  }

  return (
    <section className={card}>
      <h2 className="flex items-center gap-2 text-sm font-medium mb-4">
        <Building2 size={15} className="text-emerald-400" /> Campaigns
      </h2>
      <div className="space-y-1.5 mb-4">
        {campaigns.map((c) => (
          <CampaignRow key={c.id} campaign={c} onChanged={load} />
        ))}
        {campaigns.length === 0 && <p className="text-gray-600 text-sm">No campaigns yet.</p>}
      </div>
      <form onSubmit={add} className="flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New campaign name" className={inputCls} />
        <button type="submit" disabled={busy} className={btn}><Plus size={14} /> Add</button>
      </form>
      {msg && <p className="text-xs text-gray-400 mt-3">{msg}</p>}
    </section>
  );
}

// ─── Manager: connect/disconnect their brand's Wise account ───────────────────
function WiseSection() {
  const [status, setStatus] = useState<"loading" | "connected" | "disconnected">("loading");
  const [profileName, setProfileName] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const check = useCallback(async () => {
    const res = await apiFetch("/api/wise/balance");
    if (res.ok) {
      const data = await res.json();
      setProfileName(data?.profile?.name ?? null);
      setStatus("connected");
    } else {
      setStatus("disconnected");
    }
  }, []);
  useEffect(() => { check(); }, [check]);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    setMsg(null);
    const res = await apiFetch("/api/wise/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token.trim() }),
    });
    setBusy(false);
    if (!res.ok) return setMsg((await res.json()).error ?? "Could not connect");
    setToken("");
    await check();
  }

  async function disconnect() {
    setBusy(true);
    await apiFetch("/api/wise/settings", { method: "DELETE" });
    setBusy(false);
    setProfileName(null);
    setStatus("disconnected");
  }

  return (
    <section className={card}>
      <h2 className="flex items-center gap-2 text-sm font-medium mb-4">
        <Wallet size={15} className="text-emerald-400" /> Wise connection
      </h2>
      {status === "loading" ? (
        <p className="text-gray-600 text-sm">Checking…</p>
      ) : status === "connected" ? (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-300">
            Connected{profileName ? <span className="text-gray-500"> · {profileName}</span> : null}
          </p>
          <button onClick={disconnect} disabled={busy} className="text-xs text-red-400 hover:text-red-300">
            Disconnect
          </button>
        </div>
      ) : (
        <form onSubmit={connect} className="flex flex-col sm:flex-row gap-2">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Wise API token"
            className={inputCls}
          />
          <button type="submit" disabled={busy} className={btn}>Connect</button>
        </form>
      )}
      {msg && <p className="text-xs text-gray-400 mt-3">{msg}</p>}
    </section>
  );
}

export default function ManagePage() {
  const router = useRouter();
  const { isSuperAdmin } = useAuth();

  return (
    <div className="min-h-screen bg-[#07070e] text-white">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        <button
          onClick={() => router.push("/")}
          className="flex items-center gap-1.5 text-gray-500 hover:text-white text-sm"
        >
          <ArrowLeft size={14} /> Back to dashboard
        </button>

        <h1 className="text-lg font-semibold">Manage</h1>

        <ChangePasswordSection />

        {isSuperAdmin ? (
          <>
            <CampaignsSection />
            <TeamSection isOwner />
          </>
        ) : (
          <>
            <TeamSection isOwner={false} />
            <WiseSection />
          </>
        )}
      </div>
    </div>
  );
}

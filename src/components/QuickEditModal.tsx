"use client";

import { useState } from "react";
import { X } from "lucide-react";
import type { Creator } from "@/types";

interface Props {
  creator: Creator;
  onClose: () => void;
  onSaved: () => void;
}

export default function QuickEditModal({ creator, onClose, onSaved }: Props) {
  const [form, setForm] = useState({
    name: creator.name,
    instagram_username: creator.instagram_username || "",
    tiktok_username: creator.tiktok_username || "",
    base_fee: String(creator.base_fee),
    rate_per_thousand_views: String(creator.rate_per_thousand_views),
    affiliate_percentage: String(creator.affiliate_percentage ?? 0),
    monthly_target: String(creator.monthly_target ?? 30),
    joined_at: creator.joined_at || new Date().toISOString().split("T")[0],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await fetch(`/api/creators/${creator.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name.trim() || creator.name,
        instagram_username: form.instagram_username.trim().replace("@", "") || null,
        tiktok_username: form.tiktok_username.trim().replace("@", "") || null,
        base_fee: parseFloat(form.base_fee) || 0,
        rate_per_thousand_views: parseFloat(form.rate_per_thousand_views) || 2,
        affiliate_percentage: parseFloat(form.affiliate_percentage) || 0,
        monthly_target: parseInt(form.monthly_target) || 30,
        joined_at: form.joined_at || creator.joined_at,
      }),
    });

    setLoading(false);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Save failed — check your Supabase columns");
      return;
    }

    onSaved();
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-[#111] border border-[#1e1e1e] rounded-2xl w-full max-w-md p-6">
        <div className="flex justify-between items-center mb-5">
          <div>
            <h2 className="text-base font-semibold text-white">Edit Creator</h2>
            <p className="text-gray-500 text-xs mt-0.5">{creator.name}</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
            <X size={18}/>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="space-y-3">
            <p className="text-[11px] text-gray-600 uppercase tracking-wider font-medium">Identity</p>
            <Field label="Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} />
            <Field
              label="Instagram Username"
              value={form.instagram_username}
              onChange={v => setForm(f => ({ ...f, instagram_username: v }))}
              placeholder="@username"
            />
            <Field
              label="TikTok Username"
              value={form.tiktok_username}
              onChange={v => setForm(f => ({ ...f, tiktok_username: v }))}
              placeholder="@username"
            />
          </div>

          <div className="space-y-3">
            <p className="text-[11px] text-gray-600 uppercase tracking-wider font-medium">Payment Terms</p>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Base Fee ($/mo)"
                value={form.base_fee}
                onChange={v => setForm(f => ({ ...f, base_fee: v }))}
                type="number"
              />
              <Field
                label="Rate per 1K Views ($)"
                value={form.rate_per_thousand_views}
                onChange={v => setForm(f => ({ ...f, rate_per_thousand_views: v }))}
                type="number"
              />
            </div>
            <Field
              label="Affiliate Commission (%)"
              value={form.affiliate_percentage}
              onChange={v => setForm(f => ({ ...f, affiliate_percentage: v }))}
              type="number"
            />
          </div>

          <div className="space-y-3">
            <p className="text-[11px] text-gray-600 uppercase tracking-wider font-medium">Program</p>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Monthly Post Target"
                value={form.monthly_target}
                onChange={v => setForm(f => ({ ...f, monthly_target: v }))}
                type="number"
              />
              <Field
                label="Date Joined"
                value={form.joined_at}
                onChange={v => setForm(f => ({ ...f, joined_at: v }))}
                type="date"
              />
            </div>
          </div>

          {error && (
            <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="mt-1 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black font-semibold py-2.5 rounded-lg transition-colors text-sm"
          >
            {loading ? "Saving..." : "Save Changes"}
          </button>
        </form>
      </div>
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
        className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-white text-sm placeholder-gray-700 focus:outline-none focus:border-emerald-500 transition-colors"
      />
    </div>
  );
}

"use client";

import { useState } from "react";
import { X } from "lucide-react";

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

export default function AddCreatorModal({ onClose, onCreated }: Props) {
  const today = new Date().toISOString().split("T")[0];

  const [form, setForm] = useState({
    name: "",
    instagram_username: "",
    tiktok_username: "",
    base_fee: "",
    rate_per_thousand_views: "2",
    affiliate_percentage: "0",
    monthly_target: "30",
    joined_at: today,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return setError("Name is required");
    setLoading(true);
    setError("");

    const res = await fetch("/api/creators", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name.trim(),
        instagram_username: form.instagram_username.trim().replace("@", "") || null,
        tiktok_username: form.tiktok_username.trim().replace("@", "") || null,
        base_fee: parseFloat(form.base_fee) || 0,
        rate_per_thousand_views: parseFloat(form.rate_per_thousand_views) || 2,
        affiliate_percentage: parseFloat(form.affiliate_percentage) || 0,
        monthly_target: parseInt(form.monthly_target) || 30,
        joined_at: form.joined_at || today,
      }),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error || "Something went wrong");
      setLoading(false);
      return;
    }

    setLoading(false);
    onCreated();
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-[#0d0d15]/85 backdrop-blur-3xl border border-white/[0.14] rounded-2xl w-full max-w-md p-6 shadow-[0_24px_80px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.16)]">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-base font-semibold text-white">Add Creator</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Identity */}
          <div className="space-y-3">
            <p className="text-[11px] text-gray-500 uppercase tracking-wider font-medium">Identity</p>
            <Field
              label="Full Name *"
              value={form.name}
              onChange={(v) => setForm({ ...form, name: v })}
              placeholder="Jane Smith"
            />
            <Field
              label="Instagram Username"
              value={form.instagram_username}
              onChange={(v) => setForm({ ...form, instagram_username: v })}
              placeholder="@username"
            />
            <Field
              label="TikTok Username"
              value={form.tiktok_username}
              onChange={(v) => setForm({ ...form, tiktok_username: v })}
              placeholder="@username"
            />
          </div>

          {/* Payment */}
          <div className="space-y-3">
            <p className="text-[11px] text-gray-500 uppercase tracking-wider font-medium">Payment Terms</p>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Base Fee ($/month)"
                value={form.base_fee}
                onChange={(v) => setForm({ ...form, base_fee: v })}
                placeholder="0"
                type="number"
              />
              <Field
                label="Rate per 1K Views ($)"
                value={form.rate_per_thousand_views}
                onChange={(v) => setForm({ ...form, rate_per_thousand_views: v })}
                placeholder="2"
                type="number"
              />
            </div>
            <Field
              label="Affiliate Commission (%)"
              value={form.affiliate_percentage}
              onChange={(v) => setForm({ ...form, affiliate_percentage: v })}
              placeholder="0"
              type="number"
            />
          </div>

          {/* Program */}
          <div className="space-y-3">
            <p className="text-[11px] text-gray-500 uppercase tracking-wider font-medium">Program</p>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Monthly Post Target"
                value={form.monthly_target}
                onChange={(v) => setForm({ ...form, monthly_target: v })}
                placeholder="30"
                type="number"
              />
              <Field
                label="Date Joined"
                value={form.joined_at}
                onChange={(v) => setForm({ ...form, joined_at: v })}
                type="date"
              />
            </div>
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="mt-1 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black font-semibold py-2.5 rounded-lg transition-all text-sm shadow-[0_0_20px_rgba(52,211,153,0.2)] hover:shadow-[0_0_30px_rgba(52,211,153,0.35)]"
          >
            {loading ? "Adding..." : "Add Creator"}
          </button>
        </form>
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, placeholder, type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-gray-500 text-xs">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-emerald-500/60 focus:bg-white/[0.06] focus:shadow-[0_0_0_3px_rgba(52,211,153,0.08)] transition-all"
      />
    </div>
  );
}

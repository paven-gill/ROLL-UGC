interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
}

export default function StatCard({ label, value, sub, highlight }: StatCardProps) {
  return (
    <div className="bg-[#0d0d15]/80 backdrop-blur-xl border border-white/[0.14] rounded-xl p-5 flex flex-col gap-1 shadow-[0_8px_32px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.14)]">
      <span className="text-gray-400 text-sm">{label}</span>
      <span
        className={`text-2xl font-semibold ${
          highlight ? "text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.35)]" : "text-white"
        }`}
      >
        {value}
      </span>
      {sub && <span className="text-gray-500 text-xs">{sub}</span>}
    </div>
  );
}

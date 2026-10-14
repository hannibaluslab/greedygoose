import { STATUS_LABEL, type Status } from "@/lib/risk/status";
import type { GuardianStatus } from "@/hooks/useGuardian";

const PILL: Record<Status, { bg: string; fg: string }> = {
  none: { bg: "rgba(15,14,11,0.05)", fg: "#5a564e" },
  safe: { bg: "#d6e7dc", fg: "#1f6a4a" },
  watch: { bg: "#f6ead0", fg: "#8a6a1f" },
  act: { bg: "#f3dcd7", fg: "#8e2a1d" },
};

/** Pill sizes from the design: sm = Home card (20px), md = sheet/portfolio (22–26px). */
export function StatusPill({ status, size = "md" }: { status: Status; size?: "sm" | "md" | "lg" }) {
  const { bg, fg } = PILL[status];
  const h = size === "sm" ? 20 : size === "md" ? 24 : 26;
  return (
    <span
      className="inline-flex shrink-0 items-center font-bold"
      style={{ height: h, padding: size === "sm" ? "0 8px" : "0 10px", borderRadius: h / 2, background: bg, color: fg, fontSize: size === "sm" ? 11 : 12, gap: size === "sm" ? 5 : 6 }}
    >
      <span aria-hidden style={{ width: size === "sm" ? 5 : 6, height: size === "sm" ? 5 : 6, borderRadius: 3, background: fg }} />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Three-segment Safe / Watch / Act bar with marker. Labels always shown. */
export function StatusBar({ status, healthFactor }: { status: Status; healthFactor: number | null }) {
  // Position along the bar: HF ≥ 2.5 → far left, HF 1.0 → far right.
  const pos = healthFactor === null ? 0 : Math.min(1, Math.max(0, (2.5 - healthFactor) / 1.5));
  return (
    <div className="flex flex-col gap-2" role="img" aria-label={`Your credit is ${STATUS_LABEL[status]}`}>
      <div className="relative flex h-2 gap-1">
        <span className="rounded bg-safe" style={{ flex: 5 }} />
        <span className="rounded bg-watch" style={{ flex: 2 }} />
        <span className="rounded bg-act" style={{ flex: 1.4 }} />
        {status !== "none" && (
          <span
            aria-hidden
            className="absolute -top-1 size-4 rounded-full border-[2.5px] border-ink bg-card"
            style={{ left: `calc(${pos * 100}% - 8px)`, boxShadow: "0 2px 6px rgba(14,13,11,0.18)" }}
          />
        )}
      </div>
      <div className="flex text-xs font-semibold">
        <span className="text-safe" style={{ flex: 5 }}>Safe</span>
        <span className="text-watch-text" style={{ flex: 2 }}>Watch</span>
        <span className="text-act" style={{ flex: 1.4 }}>Act</span>
      </div>
    </div>
  );
}

/** Guardian's state: On, Off, Coming soon (its contract isn't deployed yet), or … while it loads. */
export function GuardianPill({ status }: { status: GuardianStatus }) {
  const on = status === "on";
  return (
    <span className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[12px] px-2.5 text-xs font-bold ${on ? "bg-safe-bg text-safe" : "bg-chip text-ink-mid"}`}>
      <span aria-hidden className={`size-1.5 rounded-full ${on ? "bg-safe" : "bg-subtle"}`} />
      {status === "unconfigured" ? "Coming soon" : on ? "On" : status === "loading" ? "…" : "Off"}
    </span>
  );
}

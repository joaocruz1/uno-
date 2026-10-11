import type { CSSProperties } from "react";

/**
 * Channel marks for the marketplaces UNO handles (and the ones on the roadmap).
 *
 * These are ORIGINAL marks — a brand-accent tile with the two-letter sigla UNO
 * already uses on the picking list (ML / SH / TT …) — not the platforms' own
 * trademarked logos. To show an official logo instead, drop its asset at
 * `public/channels/<id>.svg` and render it over this mark; the brand assets are
 * sourced outside the repo (owner's decision), so none are reproduced here.
 */
export type ChannelId = "mercado-livre" | "shopee" | "amazon" | "magalu" | "tiktok" | "tray";

export type Channel = {
  id: ChannelId;
  name: string;
  sigla: string;
  /** Tile background. */
  accent: string;
  /** Sigla color for contrast on the accent. */
  ink: string;
  status: "active" | "soon";
};

export const CHANNELS: Channel[] = [
  { id: "mercado-livre", name: "Mercado Livre", sigla: "ML", accent: "#FFE600", ink: "#121212", status: "active" },
  { id: "shopee", name: "Shopee", sigla: "SH", accent: "#EE4D2D", ink: "#ffffff", status: "soon" },
  { id: "amazon", name: "Amazon", sigla: "AM", accent: "#161e2d", ink: "#ff9900", status: "soon" },
  { id: "magalu", name: "Magalu", sigla: "MG", accent: "#0086ff", ink: "#ffffff", status: "soon" },
  { id: "tiktok", name: "TikTok Shop", sigla: "TT", accent: "#111113", ink: "#ffffff", status: "soon" },
  { id: "tray", name: "Tray", sigla: "TR", accent: "#0ea5a5", ink: "#ffffff", status: "soon" },
];

export const CHANNEL_BY_ID: Record<ChannelId, Channel> = Object.fromEntries(
  CHANNELS.map((channel) => [channel.id, channel]),
) as Record<ChannelId, Channel>;

export function ChannelMark({ id, size = 28, muted = false }: { id: ChannelId; size?: number; muted?: boolean }) {
  const channel = CHANNEL_BY_ID[id];
  const style: CSSProperties = {
    width: size,
    height: size,
    background: muted ? "var(--color-surface-2)" : channel.accent,
    color: muted ? "var(--color-faint)" : channel.ink,
    fontSize: size * 0.4,
    borderRadius: size * 0.28,
    boxShadow: muted ? "inset 0 0 0 1px var(--color-line)" : "none",
  };
  return (
    <span
      aria-hidden
      style={style}
      className="grid shrink-0 place-items-center font-heading font-extrabold tracking-tight"
    >
      {channel.sigla}
    </span>
  );
}

/** A compact row of channel marks with names and an "Em breve" tag on roadmap
 * ones — used to make the supported/coming channels legible at a glance. */
export function ChannelStrip({ className }: { className?: string }) {
  return (
    <ul className={className}>
      {CHANNELS.map((channel) => (
        <li
          key={channel.id}
          className="flex items-center gap-2.5 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2.5"
        >
          <ChannelMark id={channel.id} muted={channel.status === "soon"} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-[var(--color-ink)]">{channel.name}</span>
            <span className={`block text-[11px] ${channel.status === "active" ? "text-[var(--color-ok)]" : "text-[var(--color-faint)]"}`}>
              {channel.status === "active" ? "Disponível" : "Em breve"}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

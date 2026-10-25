"use client";

import { useEffect, useState, type CSSProperties } from "react";

/**
 * Channel marks for the marketplaces UNO handles (and the ones on the roadmap).
 *
 * By default these are ORIGINAL marks — a brand-accent tile with the two-letter
 * sigla UNO already uses on the picking list (ML / SH / TT …) — NOT the
 * platforms' trademarked logos, which are not reproduced here. To show an
 * official logo, drop its asset at `public/channels/<id>.svg`: {@link ChannelMark}
 * detects it and renders it in place of the sigla automatically.
 */
export type ChannelId = "mercado-livre" | "shopee" | "amazon" | "magalu" | "tiktok" | "tray";

export type Channel = {
  id: ChannelId;
  name: string;
  sigla: string;
  accent: string;
  ink: string;
  status: "active" | "soon";
};

export const CHANNELS: Channel[] = [
  { id: "mercado-livre", name: "Mercado Livre", sigla: "ML", accent: "#FFE600", ink: "#121212", status: "active" },
  { id: "shopee", name: "Shopee", sigla: "SH", accent: "#EE4D2D", ink: "#ffffff", status: "active" },
  { id: "amazon", name: "Amazon", sigla: "AM", accent: "#161e2d", ink: "#ff9900", status: "soon" },
  { id: "magalu", name: "Magalu", sigla: "MG", accent: "#0086ff", ink: "#ffffff", status: "soon" },
  { id: "tiktok", name: "TikTok Shop", sigla: "TT", accent: "#111113", ink: "#ffffff", status: "active" },
  { id: "tray", name: "Tray", sigla: "TR", accent: "#0ea5a5", ink: "#ffffff", status: "soon" },
];

export const CHANNEL_BY_ID: Record<ChannelId, Channel> = Object.fromEntries(
  CHANNELS.map((channel) => [channel.id, channel]),
) as Record<ChannelId, Channel>;

export function ChannelMark({ id, size = 28, muted = false }: { id: ChannelId; size?: number; muted?: boolean }) {
  const channel = CHANNEL_BY_ID[id];
  const [officialLogo, setOfficialLogo] = useState<string | null>(null);

  // Upgrade to the official logo only if an asset actually exists (trying the
  // common extensions the download script may save), so there is never a
  // broken-image flash when none is present.
  useEffect(() => {
    let active = true;
    const candidates = [`/channels/${id}.svg`, `/channels/${id}.png`, `/channels/${id}.webp`];
    let next = 0;
    const tryNext = () => {
      if (!active || next >= candidates.length) return;
      const url = candidates[next++];
      const probe = new Image();
      probe.onload = () => {
        if (active) setOfficialLogo(url);
      };
      probe.onerror = tryNext;
      probe.src = url;
    };
    tryNext();
    return () => {
      active = false;
    };
  }, [id]);

  const radius = size * 0.28;

  if (officialLogo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={officialLogo}
        alt=""
        aria-hidden
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: radius, opacity: muted ? 0.55 : 1, filter: muted ? "grayscale(1)" : undefined }}
        className="shrink-0 object-contain"
      />
    );
  }

  const style: CSSProperties = {
    width: size,
    height: size,
    background: muted ? "var(--color-surface-2, #fafafa)" : channel.accent,
    color: muted ? "var(--color-faint, #9a9aa2)" : channel.ink,
    fontSize: size * 0.4,
    borderRadius: radius,
    boxShadow: muted ? "inset 0 0 0 1px var(--color-line, #e8e8ec)" : "none",
  };
  return (
    <span aria-hidden style={style} className="grid shrink-0 place-items-center font-heading font-extrabold tracking-tight">
      {channel.sigla}
    </span>
  );
}

/** Resolves an engine template key (e.g. "mercado-livre" / "mercado-livre@1.0.0")
 * to a known channel id, or undefined when it is not a marketplace we map. */
export function channelIdFromTemplate(template: string): ChannelId | undefined {
  const id = template.split("@")[0] as ChannelId;
  return CHANNEL_BY_ID[id] ? id : undefined;
}

/** Inline mark + name for a marketplace, from a template key or channel id.
 * Used wherever a conversion/order shows which marketplace it belongs to. */
export function ChannelTag({ template, size = 16, className }: { template: string; size?: number; className?: string }) {
  const id = channelIdFromTemplate(template);
  if (!id) return <span className={className}>{template}</span>;
  return (
    <span className={`inline-flex items-center gap-1.5 ${className ?? ""}`}>
      <ChannelMark id={id} size={size} />
      {CHANNEL_BY_ID[id].name}
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
          className="flex items-center gap-2.5 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2.5 transition-colors hover:border-[var(--color-line-strong)]"
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

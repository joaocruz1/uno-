import Image from "next/image";
import Link from "next/link";

/**
 * The auth screens are always dark. The dashboard tokens are pinned to their
 * dark values here so shared components that use them (the invitation screen,
 * for example) stay legible inside the card.
 */
const DARK_TOKENS = {
  "--color-ink": "#fafafa",
  "--color-muted": "#a1a1aa",
  "--color-faint": "#71717a",
  "--color-line": "rgba(255, 255, 255, .09)",
  "--color-surface": "#141417",
  "--btn-neutral-bg": "rgba(255, 255, 255, .04)",
  "--btn-neutral-border": "rgba(255, 255, 255, .15)",
  "--btn-neutral-text": "#ffffff",
  "--btn-neutral-hover": "rgba(255, 255, 255, .08)",
  "--focus-offset": "#080808",
} as React.CSSProperties;

/**
 * Entrance in CSS (not JS) so the form is visible as soon as it paints, even
 * before hydration. Static for visitors who prefer reduced motion.
 */
const ENTRANCE = `
@keyframes uno-auth-in { from { opacity: 0; transform: translateY(14px); filter: blur(4px); } to { opacity: 1; transform: none; filter: none; } }
.uno-auth-in { animation: uno-auth-in .55s cubic-bezier(.22, 1, .36, 1) both; }
.uno-auth-in-late { animation-delay: .08s; }
@media (prefers-reduced-motion: reduce) { .uno-auth-in { animation: none; } }
`;

export function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-black px-4 py-12 text-white">
      <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(239,35,60,.2),transparent_34rem)]" />
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-uno-red/50 to-transparent" />
      <div className="relative w-full max-w-md">
        <style href="uno-auth-entrance" precedence="default">{ENTRANCE}</style>
        <div className="uno-auth-in">
          <Link href="/" className="mb-8 flex items-center justify-center gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red" aria-label="UNO — página inicial">
            <Image src="/uno-logo.png" width={780} height={256} alt="UNO — Duas páginas. Uma etiqueta." priority className="h-16 w-auto" />
          </Link>
        </div>
        <div className="uno-auth-in uno-auth-in-late">
          <section style={DARK_TOKENS} className="rounded-2xl border border-white/[.08] bg-[#080808] p-6 shadow-2xl shadow-black ring-1 ring-inset ring-white/[.02] sm:p-8">
            <h1 className="font-heading text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
            <p className="mt-2 text-sm leading-6 text-zinc-400">{description}</p>
            <div className="mt-7">{children}</div>
          </section>
        </div>
      </div>
    </main>
  );
}

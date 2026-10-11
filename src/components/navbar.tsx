import Image from "next/image";
import Link from "next/link";
import { Menu } from "lucide-react";
import { ButtonLink } from "./ui/button";

const links = [
  ["Como funciona", "/#como-funciona"],
  ["Recursos", "/#produto"],
  ["Preços", "/#precos"],
] as const;

export function Navbar() {
  return (
    <header className="fixed inset-x-0 top-4 z-40 px-4">
      <nav className="mx-auto flex h-16 max-w-5xl items-center justify-between rounded-full border border-[var(--nav-border)] bg-[var(--nav-bg)] px-4 shadow-[0_10px_40px_-18px_rgba(10,10,15,.3)] backdrop-blur-xl" aria-label="Navegação principal">
        <Link href="/" className="flex items-center gap-2.5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red">
          <Image src="/uno-icon.png" width={28} height={28} alt="" priority />
          <span className="font-heading text-lg font-extrabold tracking-[-.05em] text-[var(--nav-text-strong)]">UNO</span>
        </Link>
        <div className="hidden items-center gap-1 md:flex">
          {links.map(([label, href]) => <Link key={href} href={href} className="rounded-full px-4 py-2 text-sm text-[var(--nav-text)] transition-colors hover:bg-[var(--nav-hover)] hover:text-[var(--nav-text-strong)]">{label}</Link>)}
        </div>
        <div className="hidden items-center gap-2 sm:flex">
          <ButtonLink href="/login" variant="ghost" size="sm">Entrar</ButtonLink>
          <ButtonLink href="/register" size="sm">Começar agora</ButtonLink>
        </div>
        <details className="relative sm:hidden">
          <summary className="grid size-10 cursor-pointer list-none place-items-center rounded-full border border-[var(--nav-border)] text-[var(--nav-text)]"><Menu size={18} /><span className="sr-only">Abrir menu</span></summary>
          <div className="absolute right-0 top-12 flex w-56 flex-col rounded-2xl border border-[var(--nav-border)] bg-[var(--nav-surface)] p-2 shadow-2xl">
            {links.map(([label, href]) => <Link key={href} href={href} className="rounded-xl px-4 py-3 text-sm text-[var(--nav-text)] hover:bg-[var(--nav-hover)] hover:text-[var(--nav-text-strong)]">{label}</Link>)}
            <Link href="/login" className="rounded-xl px-4 py-3 text-sm text-[var(--nav-text)] hover:bg-[var(--nav-hover)] hover:text-[var(--nav-text-strong)]">Entrar</Link>
            <Link href="/register" className="mt-1 rounded-xl bg-uno-red px-4 py-3 text-center text-sm font-semibold text-white">Começar agora</Link>
          </div>
        </details>
      </nav>
    </header>
  );
}

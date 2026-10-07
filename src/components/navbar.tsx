import Image from "next/image";
import Link from "next/link";
import { Menu } from "lucide-react";
import { ButtonLink } from "./ui/button";

const links = [
  ["Produto", "/#produto"],
  ["Como funciona", "/#como-funciona"],
  ["API", "/api"],
  ["Preços", "/pricing"],
] as const;

export function Navbar() {
  return (
    <header className="fixed inset-x-0 top-4 z-40 px-4">
      <nav className="mx-auto flex h-16 max-w-5xl items-center justify-between rounded-full border border-white/10 bg-black/70 px-4 shadow-[0_12px_50px_rgba(0,0,0,.45)] backdrop-blur-xl" aria-label="Navegação principal">
        <Link href="/" className="flex items-center gap-2.5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red">
          <Image src="/uno.svg" width={28} height={28} alt="" priority />
          <span className="font-heading text-lg font-extrabold tracking-[-.05em]">UNO</span>
        </Link>
        <div className="hidden items-center gap-1 md:flex">
          {links.map(([label, href]) => <Link key={href} href={href} className="rounded-full px-4 py-2 text-sm text-zinc-400 transition-colors hover:bg-white/[.05] hover:text-white">{label}</Link>)}
        </div>
        <div className="hidden items-center gap-2 sm:flex">
          <ButtonLink href="/login" variant="ghost" size="sm">Entrar</ButtonLink>
          <ButtonLink href="/register" size="sm">Começar agora</ButtonLink>
        </div>
        <details className="relative sm:hidden">
          <summary className="grid size-10 cursor-pointer list-none place-items-center rounded-full border border-white/10 text-zinc-300"><Menu size={18} /><span className="sr-only">Abrir menu</span></summary>
          <div className="absolute right-0 top-12 flex w-56 flex-col rounded-2xl border border-white/10 bg-[#090909] p-2 shadow-2xl">
            {links.map(([label, href]) => <Link key={href} href={href} className="rounded-xl px-4 py-3 text-sm text-zinc-300 hover:bg-white/[.06]">{label}</Link>)}
            <Link href="/login" className="rounded-xl px-4 py-3 text-sm text-zinc-300 hover:bg-white/[.06]">Entrar</Link>
            <Link href="/register" className="mt-1 rounded-xl bg-uno-red px-4 py-3 text-center text-sm font-semibold text-white">Começar agora</Link>
          </div>
        </details>
      </nav>
    </header>
  );
}

import type { ReactNode } from "react";
import { Footer } from "./footer";
import { Navbar } from "./navbar";

export function PublicPage({ eyebrow, title, intro, children }: { eyebrow: string; title: string; intro: string; children: ReactNode }) {
  return (
    <main>
      <Navbar />
      <header className="hero-grid border-b border-white/[.06] pb-20 pt-36 sm:pt-44">
        <div className="page-shell relative z-10"><p className="section-kicker">{eyebrow}</p><h1 className="mt-5 max-w-4xl font-heading text-[clamp(3rem,8vw,6rem)] font-extrabold leading-[.9] tracking-[-.07em]">{title}</h1><p className="mt-7 max-w-2xl text-base leading-7 text-zinc-400 sm:text-lg">{intro}</p></div>
      </header>
      {children}
      <Footer />
    </main>
  );
}

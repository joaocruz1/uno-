"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { AnimatePresence, motion, useMotionValueEvent, useReducedMotion, useScroll, useSpring } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { ButtonLink } from "./ui/button";

type NavLink = { label: string; href: string; section?: string; path?: string };

const links: NavLink[] = [
  { label: "Como funciona", href: "/#como-funciona", section: "como-funciona" },
  { label: "Recursos", href: "/#produto", section: "produto" },
  { label: "Preços", href: "/#precos", section: "precos" },
  { label: "Documentação", href: "/docs", path: "/docs" },
];

const PILL = { type: "spring", stiffness: 520, damping: 40, mass: 0.7 } as const;

/** Which landing section is under the reading line, or null near the top. */
function useActiveSection(enabled: boolean) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const targets = links.flatMap((link) => (link.section ? [document.getElementById(link.section)] : [])).filter((node): node is HTMLElement => node !== null);
    if (!targets.length) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) setActive(entry.target.id);
        else setActive((current) => (current === entry.target.id ? null : current));
      }
    }, { rootMargin: "-40% 0px -55% 0px" });
    targets.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [enabled]);
  return enabled ? active : null;
}

export function Navbar() {
  const pathname = usePathname();
  const reduced = useReducedMotion();
  const [hovered, setHovered] = useState<string | null>(null);
  // The sheet is tied to the route it was opened on, so navigating closes it without an effect.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;
  const setOpen = (next: boolean) => setOpenAt(next ? pathname : null);
  const [scrolled, setScrolled] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  const section = useActiveSection(pathname === "/");
  const activeKey = (pathname === "/" ? links.find((link) => link.section === section) : links.find((link) => link.path && pathname.startsWith(link.path)))?.href ?? null;
  const pillKey = hovered ?? activeKey;

  const { scrollY, scrollYProgress } = useScroll();
  const bar = useSpring(scrollYProgress, { stiffness: 140, damping: 28, restDelta: 0.001 });
  useMotionValueEvent(scrollY, "change", (value) => setScrolled(value > 24));

  // Close the sheet on navigation, Escape and outside taps.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpenAt(null);
    const onPointer = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) setOpenAt(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const sheetItem = reduced ? {} : { initial: { opacity: 0, y: -6 }, animate: { opacity: 1, y: 0 } };

  return (
    <header className="fixed inset-x-0 top-4 z-40 px-4">
      <nav
        className={`relative mx-auto flex max-w-5xl items-center justify-between rounded-full border border-[var(--nav-border)] bg-[var(--nav-bg)] px-4 backdrop-blur-xl transition-[height,box-shadow] duration-300 ease-[cubic-bezier(.16,1,.3,1)] ${
          scrolled ? "h-14 shadow-[0_14px_44px_-16px_rgba(10,10,15,.42)]" : "h-16 shadow-[0_10px_40px_-18px_rgba(10,10,15,.3)]"
        }`}
        aria-label="Navegação principal"
        // Named on the nav itself: on an ancestor it would cut the backdrop blur off from the page behind.
        style={{ viewTransitionName: "site-header" }}
      >
        <Link href="/" className="flex items-center gap-2.5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red">
          <Image src="/uno-icon.png" width={28} height={28} alt="" priority />
          <span className="font-heading text-lg font-extrabold tracking-[-.05em] text-[var(--nav-text-strong)]">UNO</span>
        </Link>

        <div className="hidden items-center md:flex" onPointerLeave={() => setHovered(null)}>
          {links.map((link) => {
            const current = activeKey === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={current ? (link.path ? "page" : "location") : undefined}
                onPointerEnter={() => setHovered(link.href)}
                onFocus={() => setHovered(link.href)}
                onBlur={() => setHovered(null)}
                className={`relative rounded-full px-4 py-2 text-sm transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red ${current || hovered === link.href ? "text-[var(--nav-text-strong)]" : "text-[var(--nav-text)]"}`}
              >
                {pillKey === link.href ? (
                  <motion.span layoutId="nav-pill" transition={reduced ? { duration: 0 } : PILL} className="absolute inset-0 rounded-full bg-[var(--nav-hover)]" />
                ) : null}
                <span className="relative">{link.label}</span>
                {current ? <span className="absolute inset-x-4 -bottom-px h-0.5 rounded-full bg-uno-red" aria-hidden /> : null}
              </Link>
            );
          })}
        </div>

        <div className="hidden items-center gap-2 sm:flex">
          <ButtonLink href="/login" variant="ghost" size="sm">Entrar</ButtonLink>
          <ButtonLink href="/register" size="sm">Começar agora</ButtonLink>
        </div>

        <div ref={menu} className="relative sm:hidden">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-controls="menu-mobile"
            className="grid size-10 cursor-pointer place-items-center rounded-full border border-[var(--nav-border)] text-[var(--nav-text)] transition-colors hover:bg-[var(--nav-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red"
          >
            <AnimatePresence initial={false} mode="wait">
              <motion.span key={open ? "x" : "menu"} initial={reduced ? false : { rotate: -60, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} exit={reduced ? undefined : { rotate: 60, opacity: 0 }} transition={{ duration: 0.14 }}>
                {open ? <X size={18} /> : <Menu size={18} />}
              </motion.span>
            </AnimatePresence>
            <span className="sr-only">{open ? "Fechar menu" : "Abrir menu"}</span>
          </button>
          <AnimatePresence>
            {open ? (
              <motion.div
                id="menu-mobile"
                initial={reduced ? false : { opacity: 0, y: -8, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reduced ? undefined : { opacity: 0, y: -6, scale: 0.98, transition: { duration: 0.12 } }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                style={{ transformOrigin: "top right" }}
                className="absolute right-0 top-12 flex w-60 flex-col rounded-2xl border border-[var(--nav-border)] bg-[var(--nav-surface)] p-2 shadow-2xl"
              >
                {[...links, { label: "Entrar", href: "/login" }].map((link, index) => (
                  <motion.div key={link.href} {...sheetItem} transition={{ duration: 0.2, delay: 0.03 * index, ease: [0.16, 1, 0.3, 1] }}>
                    <Link href={link.href} onClick={() => setOpen(false)} className="block rounded-xl px-4 py-3 text-sm text-[var(--nav-text)] hover:bg-[var(--nav-hover)] hover:text-[var(--nav-text-strong)]">{link.label}</Link>
                  </motion.div>
                ))}
                <motion.div {...sheetItem} transition={{ duration: 0.2, delay: 0.03 * (links.length + 1) }}>
                  <Link href="/register" onClick={() => setOpen(false)} className="mt-1 block rounded-xl bg-uno-red px-4 py-3 text-center text-sm font-semibold text-white">Começar agora</Link>
                </motion.div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        <motion.span
          aria-hidden
          style={{ scaleX: reduced ? scrollYProgress : bar }}
          className="pointer-events-none absolute inset-x-8 bottom-0 h-0.5 origin-left rounded-full bg-uno-red"
        />
      </nav>
    </header>
  );
}

"use client";

import { Printer, ScanLine, UploadCloud } from "lucide-react";
import { useMotionValueEvent, useReducedMotion, useScroll } from "motion/react";
import { useRef, useState } from "react";

import { useHydrated } from "@/lib/use-hydrated";

import { LabelStage } from "./label-stage";

const STEPS = [
  { icon: UploadCloud, title: "Envie o PDF", text: "A etiqueta do marketplace, do jeito que o pedido baixou." },
  { icon: ScanLine, title: "Validamos os códigos", text: "Decodificamos cada código e conferimos com a chave. Não bateu, não sai." },
  { icon: Printer, title: "Imprima a 10×15", text: "Uma página pronta pra térmica, sem espaço em branco." },
] as const;

/** Where each step takes over, as a share of the section's scroll distance. */
const STEP_STARTS = [0, 0.28, 0.62] as const;

function StepList({ active }: { active: number | null }) {
  return (
    <ol className="mt-8 grid gap-3">
      {STEPS.map((step, index) => {
        const current = active === index;
        const dimmed = active !== null && !current;
        return (
          <li
            key={step.title}
            aria-current={current ? "step" : undefined}
            className={`relative flex gap-4 rounded-2xl border p-5 transition-[opacity,background-color,border-color,transform] duration-500 ease-[cubic-bezier(.16,1,.3,1)] ${
              current ? "border-uno-red/40 bg-[var(--color-surface)] shadow-[var(--shadow-card)]" : "border-transparent"
            } ${dimmed ? "opacity-45" : ""}`}
          >
            <span className={`grid size-11 shrink-0 place-items-center rounded-xl transition-colors duration-500 ${current ? "bg-uno-red text-white" : "bg-uno-red/10 text-uno-red"}`}>
              <step.icon size={22} />
            </span>
            <div>
              <h3 className="font-heading text-lg font-bold text-[var(--color-ink)]">{step.title}</h3>
              <p className="mt-1 text-sm leading-6 text-[var(--color-muted)]">{step.text}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function HowItWorks() {
  const hydrated = useHydrated();
  // Only once hydrated: the server always renders the scroll story.
  const reduced = useReducedMotion() && hydrated;
  const section = useRef<HTMLElement>(null);
  const progress = useRef(0);
  const [active, setActive] = useState(0);

  const { scrollYProgress } = useScroll({ target: section, offset: ["start start", "end end"] });
  useMotionValueEvent(scrollYProgress, "change", (value) => {
    // The merge finishes at ~75% of the distance so the finished label gets a beat to rest.
    progress.current = Math.min(1, Math.max(0, (value - 0.04) / 0.7));
    const next = value >= STEP_STARTS[2] ? 2 : value >= STEP_STARTS[1] ? 1 : 0;
    setActive((previous) => (previous === next ? previous : next));
  });

  if (reduced) {
    return (
      <section id="como-funciona" className="scroll-mt-24 px-[clamp(1.25rem,5vw,6rem)] py-14">
        <div className="mx-auto max-w-7xl">
          <h2 className="font-heading text-[clamp(1.9rem,4vw,2.6rem)] font-extrabold tracking-tight text-[var(--color-ink)]">Como funciona</h2>
          <StepList active={null} />
        </div>
      </section>
    );
  }

  return (
    <section ref={section} id="como-funciona" className="relative h-[270svh] scroll-mt-0">
      <div className="sticky top-0 flex h-svh items-center px-[clamp(1.25rem,5vw,6rem)] pb-6 pt-24">
        <div className="mx-auto grid w-full max-w-7xl items-center gap-6 lg:grid-cols-[minmax(0,.9fr)_minmax(0,1fr)] lg:gap-16">
          <div className="order-2 lg:order-1">
            <h2 className="font-heading text-[clamp(1.9rem,4vw,2.6rem)] font-extrabold tracking-tight text-[var(--color-ink)]">Como funciona</h2>
            <StepList active={active} />
          </div>
          <div className="order-1 lg:order-2">
            <div className="neon-stage relative mx-auto aspect-[5/6] max-h-[34svh] w-full overflow-hidden rounded-[30px] lg:max-h-[72svh] lg:max-w-[560px]">
              <LabelStage mode="scroll" progress={progress} label="As duas páginas se fundem numa etiqueta 10×15 conferida conforme você rola" className="absolute inset-0" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

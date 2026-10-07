"use client";

import { motion } from "motion/react";
import { Check } from "lucide-react";
import { useSyncExternalStore } from "react";
import { CombinedLabel, DanfeSheet, ShippingSheet } from "./label-art";

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onStoreChange: () => void) {
  const mediaQuery = window.matchMedia(reducedMotionQuery);
  mediaQuery.addEventListener("change", onStoreChange);
  return () => mediaQuery.removeEventListener("change", onStoreChange);
}

function getReducedMotionSnapshot() {
  return window.matchMedia(reducedMotionQuery).matches;
}

function getReducedMotionServerSnapshot() {
  return false;
}

function useHydrationSafeReducedMotion() {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot,
  );
}

export function MergeDemo() {
  const reduceMotion = useHydrationSafeReducedMotion();
  const transition = reduceMotion ? { duration: 0 } : { duration: 0.85, ease: [0.22, 1, 0.36, 1] as const };
  return (
    <div className="relative mx-auto min-h-[430px] w-full max-w-2xl overflow-hidden border border-white/10 bg-[#050505] p-5 shadow-[0_30px_100px_rgba(239,35,60,.12)] sm:p-8">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.025)_1px,transparent_1px)] bg-[size:32px_32px]" />
      <div className="relative grid grid-cols-2 gap-4 text-[10px] font-medium text-zinc-500 sm:text-[11px]">
        <span>ENTRADA · 2 PÁGINAS</span>
        <span className="text-right">SAÍDA · 1 ETIQUETA</span>
      </div>
      <div className="relative mt-8 grid min-h-72 place-items-center">
        <motion.div initial={reduceMotion ? false : { x: -56, opacity: 0 }} animate={{ x: -92, opacity: [1, 1, 0] }} transition={{ ...transition, opacity: { delay: reduceMotion ? 0 : 1.45, duration: reduceMotion ? 0 : .25 } }} className="absolute left-1/2 top-0 w-36 -translate-x-1/2 -rotate-3 sm:w-40"><ShippingSheet /></motion.div>
        <motion.div initial={reduceMotion ? false : { x: 56, opacity: 0 }} animate={{ x: 92, opacity: [1, 1, 0] }} transition={{ ...transition, opacity: { delay: reduceMotion ? 0 : 1.45, duration: reduceMotion ? 0 : .25 } }} className="absolute left-1/2 top-3 w-36 -translate-x-1/2 rotate-3 sm:w-40"><DanfeSheet /></motion.div>
        <motion.div initial={reduceMotion ? false : { scale: .9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: reduceMotion ? 0 : 1.55, ...transition }} className="absolute top-0 w-44 sm:w-48"><CombinedLabel className="min-h-72" /></motion.div>
        <motion.div initial={reduceMotion ? false : { y: -220, opacity: 0 }} animate={{ y: 235, opacity: [0, 1, 1, 0] }} transition={reduceMotion ? { duration: 0 } : { delay: .72, duration: .9, ease: "easeInOut" }} className="absolute top-0 z-20 h-px w-52 bg-uno-red shadow-[0_0_20px_6px_rgba(239,35,60,.55)]" />
      </div>
      <motion.div initial={reduceMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: reduceMotion ? 0 : 2, duration: reduceMotion ? 0 : .3 }} className="relative mx-auto mt-2 flex w-fit items-center gap-2 rounded-full border border-uno-red/30 bg-uno-red/10 px-4 py-2 text-xs text-red-200"><Check size={14} />Etiqueta pronta</motion.div>
    </div>
  );
}

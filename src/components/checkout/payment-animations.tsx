"use client";

import { motion, useAnimate, useReducedMotion } from "motion/react";
import { useCallback, type ReactNode } from "react";

import { useHydrated } from "@/lib/use-hydrated";

/**
 * Payment choreography of the checkout (NEX-52), in UNO's identity: the red
 * neon scan of the landing's label scanner while the payment is processed, a
 * laser "engraving" of the plan on a 10×15 label when it is active, a short
 * burst of sparks and a brief shake on a declined card. Everything is
 * decorative (aria-hidden, pointer-events none), animates only transform,
 * opacity and clip-path, never delays the purchase, and is off with
 * prefers-reduced-motion. Before hydration nothing motion-dependent renders, so
 * the server HTML and the first client render are the same tree.
 */
function useMotionAllowed(): boolean {
  const hydrated = useHydrated();
  const reduce = useReducedMotion();
  return hydrated && !reduce;
}

/** A red laser dot with a soft neon halo. */
function LaserDot({ size = 14 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="block rounded-full bg-white"
      style={{ width: size, height: size, boxShadow: "0 0 0 3px rgba(239,35,60,.9), 0 0 14px 6px rgba(239,35,60,.75), 0 0 34px 12px rgba(239,35,60,.35)" }}
    />
  );
}

/**
 * A red scan line sweeping a card up and down while `active` (processing the
 * payment). The sweeping layer is as tall as the card, so a translateY of
 * -100%..100% of itself crosses it exactly; no layout work per frame.
 */
export function ScanOverlay({ active }: { active: boolean }) {
  const allowed = useMotionAllowed();
  if (!active || !allowed) return null;
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-[inherit]">
      <motion.span
        className="absolute inset-x-0 top-0 block h-full"
        initial={{ y: "-100%" }}
        animate={{ y: ["-100%", "0%"] }}
        transition={{ duration: 1.6, ease: [0.45, 0, 0.55, 1], repeat: Infinity, repeatType: "reverse" }}
      >
        <span className="absolute inset-x-0 bottom-0 block h-16 bg-[linear-gradient(to_bottom,transparent,rgba(239,35,60,.12)_60%,rgba(255,92,110,.75)_96%,transparent)] shadow-[0_10px_26px_2px_rgba(239,35,60,.35)]" />
      </motion.span>
    </span>
  );
}

const ENGRAVE_SECONDS = 1.1;
const ENGRAVE_DELAY = 0.2;

/**
 * Text "engraved" by a laser dot travelling left to right: the text is revealed
 * behind the dot with clip-path. With reduced motion it is simply shown.
 */
export function EngravedText({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const allowed = useMotionAllowed();
  const start = ENGRAVE_DELAY + delay;
  return (
    <span className={`relative inline-block ${className ?? ""}`}>
      <motion.span
        className="block"
        initial={allowed ? { clipPath: "inset(0 100% 0 0)" } : false}
        animate={{ clipPath: "inset(0 0% 0 0)" }}
        transition={{ duration: ENGRAVE_SECONDS, ease: "linear", delay: start }}
      >
        {children}
      </motion.span>
      {allowed ? (
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-1/2 -ml-[7px] -mt-[7px] block w-full"
          initial={{ x: "0%", opacity: 1 }}
          animate={{ x: "100%", opacity: 0 }}
          transition={{ x: { duration: ENGRAVE_SECONDS, ease: "linear", delay: start }, opacity: { duration: 0.2, delay: start + ENGRAVE_SECONDS } }}
        >
          <LaserDot />
        </motion.span>
      ) : null}
    </span>
  );
}

/** How long the engraving of `lines` takes, so the sparks fire when it ends. */
export function engravingSeconds(lines: number): number {
  return ENGRAVE_DELAY + Math.max(1, lines) * ENGRAVE_SECONDS;
}

/**
 * Deterministic spark directions (no randomness: stable across renders and
 * testable). Each spark gets an angle around the circle, a distance and a size.
 */
export function sparkVectors(count: number): Array<{ x: number; y: number; size: number; white: boolean }> {
  return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, index) => {
    const angle = (index / count) * Math.PI * 2 + (index % 2 ? 0.18 : -0.12);
    const distance = 56 + ((index * 37) % 5) * 12;
    return {
      x: Math.round(Math.cos(angle) * distance),
      y: Math.round(Math.sin(angle) * distance),
      size: 3 + (index % 3),
      white: index % 3 === 0,
    };
  });
}

/** A one-off burst of red and white sparks (~1 s) from the centre of its parent. */
export function SparkBurst({ play, delay = 0, count = 14 }: { play: boolean; delay?: number; count?: number }) {
  const allowed = useMotionAllowed();
  if (!play || !allowed) return null;
  return (
    <span aria-hidden="true" className="pointer-events-none absolute left-1/2 top-1/2 z-20 block size-0">
      {sparkVectors(count).map((spark, index) => (
        <motion.span
          key={index}
          className={`absolute block rounded-full ${spark.white ? "bg-white" : "bg-uno-red"}`}
          style={{ width: spark.size, height: spark.size, marginLeft: -spark.size / 2, marginTop: -spark.size / 2, boxShadow: "0 0 10px 2px rgba(239,35,60,.7)" }}
          initial={{ x: 0, y: 0, opacity: 0, scale: 0.6 }}
          animate={{ x: spark.x, y: [0, spark.y * 0.7, spark.y + 18], opacity: [0, 1, 0], scale: [0.6, 1.2, 0.4] }}
          transition={{ duration: 0.95, ease: [0.22, 1, 0.36, 1], delay: delay + (index % 4) * 0.03 }}
        />
      ))}
    </span>
  );
}

/**
 * A short horizontal shake (≤ 300 ms) for a declined card. Returns the ref for
 * the element and a `shake()` that does nothing with reduced motion.
 */
export function useShake<T extends HTMLElement>() {
  const [scope, animate] = useAnimate<T>();
  const reduce = useReducedMotion();
  const shake = useCallback(() => {
    if (reduce || !scope.current) return;
    void animate(scope.current, { x: [0, -8, 7, -5, 3, 0] }, { duration: 0.28, ease: "easeOut" });
  }, [animate, reduce, scope]);
  return [scope, shake] as const;
}

/** An inline spinner for busy buttons. */
export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden="true" className={`inline-block size-4 animate-spin rounded-full border-2 border-white/40 border-t-white motion-reduce:animate-none ${className ?? ""}`} />;
}

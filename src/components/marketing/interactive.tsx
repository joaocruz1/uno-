"use client";

import { motion, useMotionValue, useReducedMotion, useSpring } from "motion/react";
import type { ReactNode, PointerEvent } from "react";

/** Card whose surface follows the pointer with a soft red light. CSS-variable only: no re-render per move. */
export function SpotlightCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty("--mx", `${event.clientX - box.left}px`);
    event.currentTarget.style.setProperty("--my", `${event.clientY - box.top}px`);
  };
  return <div onPointerMove={onMove} className={`spotlight ${className}`}>{children}</div>;
}

/** Pulls its child a few pixels toward the pointer; springs back on leave. */
export function Magnetic({ children, strength = 0.28, className = "" }: { children: ReactNode; strength?: number; className?: string }) {
  const reduced = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 260, damping: 18, mass: 0.4 });
  const sy = useSpring(y, { stiffness: 260, damping: 18, mass: 0.4 });
  // Same element on the server and the client (the reduced-motion preference is
  // only known in the browser); reduced motion just turns the effect off.
  return (
    <motion.span
      className={`inline-block ${className}`}
      style={{ x: sx, y: sy }}
      onPointerMove={(event) => {
        if (reduced || event.pointerType !== "mouse") return;
        const box = event.currentTarget.getBoundingClientRect();
        x.set((event.clientX - (box.left + box.width / 2)) * strength);
        y.set((event.clientY - (box.top + box.height / 2)) * strength);
      }}
      onPointerLeave={() => { x.set(0); y.set(0); }}
      whileTap={{ scale: reduced ? 1 : 0.97 }}
    >
      {children}
    </motion.span>
  );
}

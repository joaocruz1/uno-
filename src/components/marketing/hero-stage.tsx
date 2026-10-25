"use client";

import { useReducedMotion } from "motion/react";
import { useState } from "react";

import { useHydrated } from "@/lib/use-hydrated";

import { LabelScanner } from "./label-scanner";
import { LabelStage, type StageStatus } from "./label-stage";

/**
 * Hero visual: two loose pages fuse into the 10×15 label in WebGL. The existing
 * CSS scanner stays underneath until the scene is live, and remains the only
 * visual when WebGL is missing or the visitor asks for less motion.
 */
export function HeroStage() {
  const reduced = useReducedMotion();
  const [status, setStatus] = useState<StageStatus | "loading">("loading");
  // The motion preference only exists in the browser: the first render (server
  // and hydration) is always the scanner, and the scene mounts afterwards.
  const hydrated = useHydrated();
  const showStage = hydrated && !reduced;
  const live = showStage && status === "ready";

  return (
    <div className="relative aspect-[4/5] w-full max-w-[460px]">
      {showStage && status !== "failed" ? (
        <div className={`absolute inset-0 transition-opacity duration-700 ${live ? "opacity-100" : "opacity-0"}`}>
          <div className="neon-stage h-full w-full overflow-hidden rounded-[30px]">
            <LabelStage mode="loop" onStatus={setStatus} label="Duas páginas se fundem em uma etiqueta 10×15 conferida" className="absolute inset-0" />
          </div>
        </div>
      ) : null}
      <div className={`absolute inset-0 flex items-center justify-center transition-opacity duration-500 ${live ? "pointer-events-none opacity-0" : "opacity-100"}`} aria-hidden={live}>
        <LabelScanner />
      </div>
    </div>
  );
}

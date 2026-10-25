"use client";

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * False on the server and during hydration, true afterwards. Browser-only
 * preferences (reduced motion, WebGL) must only change the tree once this is
 * true, or the client's first render will not match the server HTML.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

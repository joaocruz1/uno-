import { ViewTransition, type ReactNode } from "react";

/**
 * Cross-fades route content on navigation. Lives in a template (not a layout),
 * because layouts persist across navigations and never fire enter/exit.
 * The animation itself is defined by the `.page-*` classes in globals.css.
 */
export function PageTransition({ children, scope = "page" }: { children: ReactNode; scope?: "page" | "panel" }) {
  return (
    <ViewTransition enter={`${scope}-in`} exit={`${scope}-out`} default="none">
      {children}
    </ViewTransition>
  );
}

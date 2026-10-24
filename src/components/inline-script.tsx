"use client";

/**
 * A script that runs while the HTML is parsed (before first paint) and is
 * inert when React renders it on the client: browsers never run scripts that
 * React inserts, and React warns about rendering one. See
 * node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md.
 */
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

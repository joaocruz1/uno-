import type { HTMLAttributes } from "react";
import { cn } from "./utils";

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("inline-flex items-center gap-2 rounded-full border border-uno-red/30 bg-uno-red/10 px-3 py-1 text-xs font-semibold text-[#ff6b7e]", className)} {...props} />;
}

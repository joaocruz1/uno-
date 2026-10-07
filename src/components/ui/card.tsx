import type { HTMLAttributes } from "react";
import { cn } from "./utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("border border-white/10 bg-[#080808]", className)} {...props} />;
}

import type { HTMLAttributes } from "react";
import { cn } from "./utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("border border-[var(--c-line)] bg-[var(--c-surface)]", className)} {...props} />;
}

import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "./utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn("h-11 w-full rounded-lg border border-[var(--c-line)] bg-[var(--c-surface-2)] px-3 text-sm text-[var(--c-ink)] outline-none placeholder:text-[var(--c-faint)] focus:border-uno-red/70 focus:ring-2 focus:ring-uno-red/20 disabled:opacity-50", className)} {...props} />;
});

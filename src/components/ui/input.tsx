import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "./utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn("h-11 w-full rounded-lg border border-white/10 bg-white/[.04] px-3 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-uno-red/70 focus:ring-2 focus:ring-uno-red/20 disabled:opacity-50", className)} {...props} />;
});

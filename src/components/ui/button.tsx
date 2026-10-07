import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./utils";

const variants = {
  primary: "bg-uno-red text-white shadow-[0_0_28px_rgba(239,35,60,.24)] hover:bg-[#ff334b]",
  secondary: "border border-white/15 bg-white/[.04] text-white hover:bg-white/[.08]",
  ghost: "text-zinc-300 hover:bg-white/[.06] hover:text-white",
} as const;

type SharedProps = {
  children: ReactNode;
  className?: string;
  variant?: keyof typeof variants;
  size?: "sm" | "md" | "lg";
};

const sizes = {
  sm: "h-9 px-4 text-sm",
  md: "h-11 px-5 text-sm",
  lg: "h-13 px-7 text-sm",
} as const;

export function Button({ className, variant = "primary", size = "md", type = "button", ...props }: SharedProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cn("inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:pointer-events-none disabled:opacity-50", variants[variant], sizes[size], className)}
      {...props}
    />
  );
}

export function ButtonLink({ className, variant = "primary", size = "md", children, href, ...props }: SharedProps & AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <Link
      href={href}
      className={cn("inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red focus-visible:ring-offset-2 focus-visible:ring-offset-black", variants[variant], sizes[size], className)}
      {...props}
    >
      {children}
    </Link>
  );
}

import type { HTMLAttributes, TableHTMLAttributes } from "react";
import { cn } from "./utils";

export function Table({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return <div className="w-full overflow-x-auto"><table className={cn("w-full min-w-[640px] border-collapse text-left text-sm", className)} {...props} /></div>;
}

export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("border-b border-white/10 text-xs text-zinc-500", className)} {...props} />;
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("border-b border-white/[.06] transition-colors hover:bg-white/[.025]", className)} {...props} />;
}

export function TableHead({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn("px-4 py-3 font-medium", className)} {...props} />;
}

export function TableCell({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-4 py-4 text-zinc-300", className)} {...props} />;
}

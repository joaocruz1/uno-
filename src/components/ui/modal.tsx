"use client";

import { X } from "lucide-react";
import type { ReactNode } from "react";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
};

export function Modal({ open, onClose, title, description, children }: ModalProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4 backdrop-blur-sm" role="presentation" onMouseDown={onClose}>
      <section className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#090909] p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="modal-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="modal-title" className="font-heading text-xl font-bold">{title}</h2>
            {description ? <p className="mt-1 text-sm text-zinc-400">{description}</p> : null}
          </div>
          <button className="rounded-full p-2 text-zinc-400 hover:bg-white/10 hover:text-white" onClick={onClose} aria-label="Fechar janela"><X size={18} /></button>
        </div>
        <div className="mt-5">{children}</div>
      </section>
    </div>
  );
}

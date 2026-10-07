"use client";

import { X } from "lucide-react";
import { useRef, type ReactNode, type RefObject } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

export function Modal({ open, onClose, title, description, children, returnFocusRef }: ModalProps) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={next => { if (!next) onClose(); }}>
      <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm"/>
      <DialogPrimitive.Content {...(!description ? { "aria-describedby": undefined } : {})} onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onCloseAutoFocus={event => { event.preventDefault(); const target = returnFocusRef?.current ?? returnFocus.current; if (target?.isConnected) target.focus(); }} className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-white/10 bg-[#090909] p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <DialogPrimitive.Title className="font-heading text-xl font-bold">{title}</DialogPrimitive.Title>
            {description ? <DialogPrimitive.Description className="mt-1 text-sm text-zinc-400">{description}</DialogPrimitive.Description> : null}
          </div>
          <DialogPrimitive.Close asChild><button type="button" className="rounded-full p-2 text-zinc-400 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-uno-red" aria-label="Fechar janela"><X size={18} /></button></DialogPrimitive.Close>
        </div>
        <div className="mt-5">{children}</div>
      </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

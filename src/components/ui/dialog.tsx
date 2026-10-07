"use client";

import type { ReactNode } from "react";
import { Button } from "./button";
import { Modal } from "./modal";

type DialogProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  children?: ReactNode;
};

export function Dialog({ open, onClose, onConfirm, title, description, confirmLabel = "Confirmar", children }: DialogProps) {
  return (
    <Modal open={open} onClose={onClose} title={title} description={description}>
      {children}
      <div className="mt-6 flex justify-end gap-3">
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </Modal>
  );
}

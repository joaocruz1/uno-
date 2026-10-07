"use client";

import { FileUp } from "lucide-react";
import { useRef, useState, type DragEvent, type InputHTMLAttributes } from "react";
import { cn } from "./utils";

type DropzoneProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> & {
  label?: string;
  hint?: string;
  onFiles?: (files: FileList) => void;
};

export function Dropzone({ className, label = "Arraste seu PDF aqui", hint = "PDF", onFiles, ...props }: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const acceptFiles = (files: FileList | null) => files?.length && onFiles?.(files);
  const onDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragging(false);
    acceptFiles(event.dataTransfer.files);
  };
  return (
    <div className={className}>
      <button type="button" onClick={() => inputRef.current?.click()} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} className={cn("group flex min-h-56 w-full flex-col items-center justify-center border border-dashed p-8 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red", dragging ? "border-uno-red bg-uno-red/10" : "border-white/20 bg-white/[.02] hover:border-uno-red/60 hover:bg-uno-red/[.04]")}>
        <span className="grid size-12 place-items-center rounded-full bg-uno-red/10 text-uno-red"><FileUp /></span>
        <strong className="mt-4 font-heading text-lg">{label}</strong>
        <span className="mt-1 text-sm text-zinc-500">ou selecione um arquivo · {hint}</span>
      </button>
      <input ref={inputRef} type="file" className="sr-only" onChange={(event) => acceptFiles(event.target.files)} {...props} />
    </div>
  );
}

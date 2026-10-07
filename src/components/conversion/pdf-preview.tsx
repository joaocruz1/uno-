"use client";

import { FileText, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function PdfCanvasPreview({ url, data, title, expectedPages, className }: { url?: string; data?: Uint8Array; title: string; expectedPages: 1 | 2; className?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    const controller = new AbortController();
    let loadingTask: import("pdfjs-dist").PDFDocumentLoadingTask | undefined;
    let renderTask: import("pdfjs-dist").RenderTask | undefined;
    const render = async () => {
      try {
        let bytes: Uint8Array;
        if (data) {
          // pdf.js transfers the buffer to its worker; keep the caller's copy intact.
          bytes = data.slice();
        } else {
          if (!url) throw new Error("preview_unavailable");
          const response = await fetch(url, { signal: controller.signal, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
          if (!response.ok || Number(response.headers.get("content-length")) > 150 * 1_024 * 1_024) throw new Error("preview_unavailable");
          bytes = new Uint8Array(await response.arrayBuffer());
        }
        if (controller.signal.aborted) return;
        if (bytes.length > 150 * 1_024 * 1_024) throw new Error("preview_unavailable");
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = `/pdfjs/pdf.worker.${pdfjs.version}.min.mjs`;
        const assetRoot = `/pdfjs/${pdfjs.version}/`;
        const task = pdfjs.getDocument({ data: bytes, enableXfa: false, maxImageSize: 15_000_000, verbosity: 0,
          standardFontDataUrl: `${assetRoot}standard_fonts/`, cMapUrl: `${assetRoot}cmaps/`, cMapPacked: true, wasmUrl: `${assetRoot}wasm/` });
        loadingTask = task;
        const pdf = await task.promise;
        if (pdf.numPages !== expectedPages) throw new Error("preview_unavailable");
        const fragment = document.createDocumentFragment();
        for (let index = 1; index <= pdf.numPages; index += 1) {
          if (controller.signal.aborted) return;
          const page = await pdf.getPage(index);
          const natural = page.getViewport({ scale: 1 });
          const cssWidth = Math.min(container.current?.clientWidth || 420, 720);
          const viewport = page.getViewport({ scale: cssWidth * Math.min(window.devicePixelRatio || 1, 2) / natural.width });
          if (viewport.width * viewport.height > 15_000_000) throw new Error("preview_unavailable");
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          canvas.style.width = "100%";
          canvas.style.height = "auto";
          canvas.style.display = "block";
          canvas.setAttribute("role", "img");
          canvas.setAttribute("aria-label", `${title}, página ${index}`);
          renderTask = page.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE, background: "white" });
          await renderTask.promise;
          fragment.appendChild(canvas);
        }
        if (controller.signal.aborted || !container.current) return;
        container.current.replaceChildren(fragment);
        setPhase("ready");
      } catch {
        if (!controller.signal.aborted) setPhase("unavailable");
      } finally {
        await loadingTask?.destroy().catch(() => undefined);
      }
    };
    void render();
    return () => {
      controller.abort();
      renderTask?.cancel();
      void loadingTask?.destroy().catch(() => undefined);
    };
  }, [url, data, title, expectedPages]);

  return <div className={className ?? "relative h-[480px] overflow-auto bg-white sm:h-[560px]"}>
    {phase === "loading" ? <div className="absolute inset-0 grid place-content-center text-center text-zinc-600" role="status"><LoaderCircle className="mx-auto mb-4 animate-spin motion-reduce:animate-none"/><p className="text-sm">Preparando a visualização</p></div> : null}
    {phase === "unavailable" ? <div className="grid h-full place-content-center p-8 text-center text-zinc-700"><FileText className="mx-auto mb-4"/><p className="text-sm">A visualização está indisponível. Use “Abrir PDF” para conferir o arquivo.</p></div> : null}
    <div ref={container} className="space-y-3"/>
  </div>;
}

import { inflateSync } from "node:zlib";

/**
 * ZPL ingestion for the Full Mercado Livre label (and Shopee's thermal export),
 * which arrive as ZPL (.zpl/.txt/.zip or pasted) instead of a PDF. Rendering ZPL
 * to a raster is a WASM-engine job validated against real labels (golden tests);
 * this module is the part that runs *before* that and is independent of any one
 * label: it bounds the input, splits it into label blocks and defuses the
 * `:Z64:`/`:B64:` graphic fields so a crafted file cannot exhaust memory.
 *
 * Everything runs inside the isolated engine process, where the RSS watchdog
 * already covers native/WASM memory (plan, Fase 5).
 */

export type ZplErrorCode =
  | "zpl_too_large"
  | "zpl_empty"
  | "zpl_too_many_blocks"
  | "zpl_decompression_bomb"
  | "zpl_render_unavailable";

const SAFE_MESSAGES: Record<ZplErrorCode, string> = {
  zpl_too_large: "O arquivo ZPL é maior do que o limite aceito.",
  zpl_empty: "Nenhuma etiqueta ZPL (^XA…^XZ) foi encontrada no arquivo.",
  zpl_too_many_blocks: "O arquivo ZPL tem mais etiquetas do que o limite por lote.",
  zpl_decompression_bomb: "Um campo gráfico compactado do ZPL excede o limite de tamanho.",
  zpl_render_unavailable: "A rasterização de ZPL ainda não está disponível.",
};

export class ZplError extends Error {
  constructor(
    readonly code: ZplErrorCode,
    message?: string,
  ) {
    super(message ?? SAFE_MESSAGES[code]);
    this.name = "ZplError";
  }
}

export type ZplLimits = {
  /** Raw input ceiling in bytes. Default 4 MiB. */
  maxBytes: number;
  /** Maximum number of ^XA…^XZ label blocks. Default 1000. */
  maxBlocks: number;
  /** Maximum copies honored from a single ^PQ. Default 50. */
  maxCopies: number;
  /** Decoded-size ceiling for one :Z64:/:B64: graphic field. Default 8 MiB. */
  maxDecodedBytesPerField: number;
  /** Decoded-size ceiling summed across all graphic fields. Default 32 MiB. */
  maxDecodedBytesTotal: number;
};

export const DEFAULT_ZPL_LIMITS: ZplLimits = {
  maxBytes: 4 * 1024 * 1024,
  maxBlocks: 1000,
  maxCopies: 50,
  maxDecodedBytesPerField: 8 * 1024 * 1024,
  maxDecodedBytesTotal: 32 * 1024 * 1024,
};

export type ZplBlock = {
  /** The ^XA…^XZ label source, trimmed. */
  raw: string;
  /** Copies requested by ^PQ (clamped to maxCopies); 1 when absent. */
  copies: number;
};

export type ZplDocument = {
  blocks: ZplBlock[];
  /** Sum of copies across every block — how many physical labels print. */
  totalLabels: number;
  /** Total decoded bytes of all graphic fields, after the bomb check. */
  decodedGraphicBytes: number;
};

/** :Z64: (zlib) and :B64: (plain) base64 graphic payloads, with the trailing CRC. */
const GRAPHIC_FIELD = /:(Z64|B64):([A-Za-z0-9+/=]+):([0-9A-Fa-f]{1,8})/g;
const BLOCK = /\^XA([\s\S]*?)\^XZ/g;
const PQ = /\^PQ\s*(\d+)/;

function decodeGraphicField(kind: string, payload: string, perFieldCap: number): number {
  const compressed = Buffer.from(payload, "base64");
  if (kind === "B64") {
    if (compressed.byteLength > perFieldCap) throw new ZplError("zpl_decompression_bomb");
    return compressed.byteLength;
  }
  try {
    const decoded = inflateSync(compressed, { maxOutputLength: perFieldCap });
    return decoded.byteLength;
  } catch (error) {
    // Node throws RangeError once the output passes maxOutputLength — the zip-bomb case.
    if (error instanceof RangeError) throw new ZplError("zpl_decompression_bomb");
    throw new ZplError("zpl_decompression_bomb", "Campo gráfico :Z64: inválido ou corrompido.");
  }
}

/**
 * Bounds and structures raw ZPL for rendering: enforces the byte ceiling, splits
 * into ^XA…^XZ blocks, reads ^PQ copies, and decodes every :Z64:/:B64: field
 * under a cap so a compression bomb is rejected instead of inflating in memory.
 * It never renders — that is {@link ZplRenderer}.
 */
export function preprocessZpl(input: string, overrides: Partial<ZplLimits> = {}): ZplDocument {
  const limits = { ...DEFAULT_ZPL_LIMITS, ...overrides };
  const byteLength = Buffer.byteLength(input, "utf8");
  if (byteLength > limits.maxBytes) {
    throw new ZplError("zpl_too_large", `O arquivo tem ${byteLength} bytes; o limite é ${limits.maxBytes}.`);
  }

  const blocks: ZplBlock[] = [];
  let totalLabels = 0;
  let decodedGraphicBytes = 0;

  for (const match of input.matchAll(BLOCK)) {
    if (blocks.length >= limits.maxBlocks) {
      throw new ZplError("zpl_too_many_blocks", `O arquivo tem mais de ${limits.maxBlocks} etiquetas.`);
    }
    const body = match[1];
    const raw = `^XA${body}^XZ`;

    for (const field of raw.matchAll(GRAPHIC_FIELD)) {
      decodedGraphicBytes += decodeGraphicField(field[1], field[2], limits.maxDecodedBytesPerField);
      if (decodedGraphicBytes > limits.maxDecodedBytesTotal) throw new ZplError("zpl_decompression_bomb");
    }

    const pq = PQ.exec(body);
    const copies = pq ? Math.min(Math.max(Number.parseInt(pq[1], 10) || 1, 1), limits.maxCopies) : 1;
    blocks.push({ raw: raw.trim(), copies });
    totalLabels += copies;
  }

  if (blocks.length === 0) throw new ZplError("zpl_empty");
  return { blocks, totalLabels, decodedGraphicBytes };
}

export type ZplRenderTarget = {
  /** Dots per millimeter: 8 = 203 dpi, 12 = 300 dpi. */
  dpmm: 8 | 12;
  widthMm: number;
  heightMm: number;
};

/**
 * Rasterizes preprocessed ZPL to one image per label, at the target density.
 * The concrete engine (a local WASM renderer — never an external API, since the
 * label carries name/address/CPF) is chosen by golden tests against real labels,
 * so no engine is wired yet; the interface lets the rest of the pipeline and the
 * code-equivalence check (decode each rendered code, compare to its ^FD) be
 * written now. See the plan, Fase 5.
 */
export interface ZplRenderer {
  render(document: ZplDocument, target: ZplRenderTarget): Promise<Uint8Array[]>;
}

/** No renderer is bound until one is validated against a real label; refuses with
 * a typed error rather than emitting an unverified raster. */
export function createZplRenderer(): ZplRenderer {
  return {
    render: async () => {
      throw new ZplError(
        "zpl_render_unavailable",
        "A rasterização de ZPL depende de um motor local validado em etiquetas reais (testes dourados); o pré-processamento já está pronto.",
      );
    },
  };
}

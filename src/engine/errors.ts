import type { OutputSize } from "./types";

export type EngineErrorCode =
  | "invalid_pdf"
  | "pdf_encrypted"
  | "invalid_page_count"
  | "unsupported_template"
  | "ambiguous_template"
  | "missing_required_region"
  | "codes_unreadable"
  | "format_too_small"
  | "validation_failed"
  | "ocr_unavailable";

const SAFE_MESSAGES: Record<EngineErrorCode, string> = {
  invalid_pdf: "O PDF é inválido ou está corrompido.",
  pdf_encrypted: "PDFs protegidos por senha não são aceitos.",
  invalid_page_count: "O PDF deve conter exatamente duas páginas.",
  unsupported_template: "O modelo do documento não é compatível.",
  ambiguous_template: "Não foi possível determinar a função de cada página.",
  missing_required_region: "Uma região obrigatória não foi encontrada.",
  codes_unreadable: "Um código protegido não pôde ser validado.",
  format_too_small: "O formato solicitado não preserva a legibilidade. Escolha um formato maior.",
  validation_failed: "O resultado não passou na validação.",
  ocr_unavailable: "O reconhecimento do documento está temporariamente indisponível.",
};

export class EngineError extends Error {
  readonly terminal: boolean;
  readonly suggestedSize?: OutputSize;

  constructor(
    readonly code: EngineErrorCode,
    options: { terminal?: boolean; suggestedSize?: OutputSize } = {},
  ) {
    super(SAFE_MESSAGES[code]);
    this.name = "EngineError";
    this.terminal = options.terminal ?? code !== "ocr_unavailable";
    this.suggestedSize = options.suggestedSize;
  }
}

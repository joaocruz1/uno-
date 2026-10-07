import { AppError } from "@/lib/errors";
import { errorResponse } from "@/server/http";

export function publicApiErrorResponse(error: unknown, requestId: string): Response {
  if (error instanceof AppError && error.code === "rate_limit_exceeded") {
    return errorResponse(new AppError("rate_limited", "Muitas solicitações. Tente novamente em instantes.", 429, error.details), requestId);
  }
  if (error instanceof AppError && error.status === 499) {
    return errorResponse(new AppError("request_aborted", "A transferência foi interrompida.", 400), requestId);
  }
  return errorResponse(error, requestId);
}

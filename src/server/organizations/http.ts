import { appUrl } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { SELECTED_ORGANIZATION_COOKIE } from "@/server/auth/actor";
import { assertSameOrigin, errorResponse, requestId } from "@/server/http";

type RouteInput<Params> = { request: Request; id: string; params: Params; headers: Headers };

/** Shared envelope for management and administration routes: same-origin mutations and safe errors. */
export function managementRoute<Params = Record<string, never>>(
  handler: (input: RouteInput<Params>) => Promise<Response>,
): (request: Request, context: { params: Promise<Params> }) => Promise<Response> {
  return async (request, context) => {
    const id = requestId(request);
    try {
      assertSameOrigin(request);
      return await handler({ request, id, params: await context.params, headers: new Headers(request.headers) });
    } catch (error) {
      return errorResponse(error, id);
    }
  };
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AppError("invalid_request", "A solicitação contém dados inválidos.", 400);
  }
}

export function jsonResponse(id: string, body: Record<string, unknown>, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return Response.json({ requestId: id, ...body }, { status: init.status ?? 200, headers: { "cache-control": "no-store", ...init.headers } });
}

export function emptyResponse(id: string): Response {
  return new Response(null, { status: 204, headers: { "x-request-id": id, "cache-control": "no-store" } });
}

/** httpOnly preference cookie. Authorization is always re-read from memberships. */
export function selectionCookie(organizationId: string): string {
  let secure = process.env.NODE_ENV === "production";
  try {
    secure ||= new URL(appUrl()).protocol === "https:";
  } catch {
    secure = true;
  }
  return `${SELECTED_ORGANIZATION_COOKIE}=${encodeURIComponent(organizationId)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

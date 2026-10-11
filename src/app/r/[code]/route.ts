import { REFERRAL_COOKIE } from "@/server/billing/referrals";

export const runtime = "nodejs";

const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Remembers the referral code in a cookie, then sends the visitor to sign up. */
export async function GET(request: Request, context: { params: Promise<{ code: string }> }): Promise<Response> {
  const { code } = await context.params;
  const location = new URL("/register", request.url);
  const headers = new Headers({ Location: location.toString() });
  if (/^[A-Za-z0-9_-]{4,64}$/.test(code)) {
    const secure = process.env.NODE_ENV === "production" ? " Secure;" : "";
    headers.append("Set-Cookie", `${REFERRAL_COOKIE}=${encodeURIComponent(code)}; Path=/; Max-Age=${MAX_AGE_SECONDS}; HttpOnly;${secure} SameSite=Lax`);
  }
  return new Response(null, { status: 302, headers });
}

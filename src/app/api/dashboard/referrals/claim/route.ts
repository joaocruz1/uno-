import { createHash } from "node:crypto";

import { requireActor, withJsonHandler } from "@/server/http";
import { linkReferral, REFERRAL_COOKIE } from "@/server/billing/referrals";

export const runtime = "nodejs";

function cookieValue(header: string | null, name: string): string | undefined {
  const match = header?.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]!) : undefined;
}

function hashIp(headers: Headers): string | undefined {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded ? createHash("sha256").update(forwarded).digest("hex") : undefined;
}

/** Links the signed-in user to a referrer remembered in the cookie, then clears it. */
export const POST = withJsonHandler(async (request, requestId) => {
  const actor = await requireActor(request.headers);
  const code = cookieValue(request.headers.get("cookie"), REFERRAL_COOKIE);
  let linked = false;
  if (code) {
    ({ linked } = await linkReferral({ code, referredUserId: actor.userId, signupIpHash: hashIp(request.headers) }));
  }
  const secure = process.env.NODE_ENV === "production" ? " Secure;" : "";
  const headers = new Headers({ "cache-control": "no-store" });
  headers.append("Set-Cookie", `${REFERRAL_COOKIE}=; Path=/; Max-Age=0; HttpOnly;${secure} SameSite=Lax`);
  return Response.json({ requestId, linked }, { headers });
});

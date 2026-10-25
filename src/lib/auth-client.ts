"use client";

import { inferAdditionalFields } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// The client mirrors the server's additional user fields so `signUp.email` and
// `updateUser` accept `phone` (validated and normalized on the server).
export const authClient = createAuthClient({
  plugins: [inferAdditionalFields({ user: { phone: { type: "string", required: false } } })],
});

export { safeInternalPath } from "./safe-path";

import { afterEach, expect, it, vi } from "vitest";
import { authEnvironment, requiredEnv } from "@/lib/env";
afterEach(()=>vi.unstubAllEnvs());
it("rejects missing service credentials at use instead of inventing them",()=>{vi.stubEnv("UNO_MISSING_TEST", "");expect(()=>requiredEnv("UNO_MISSING_TEST")).toThrow("Configuração");});
it("rejects short authentication secrets",()=>{vi.stubEnv("BETTER_AUTH_SECRET","unsafe");vi.stubEnv("BETTER_AUTH_URL","http://localhost:3000");expect(()=>authEnvironment()).toThrow();});

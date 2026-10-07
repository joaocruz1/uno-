import { spawnSync } from "node:child_process";
for (const task of ["lint", "typecheck", "test", "build"]) {
  const result = spawnSync("pnpm", [task], { stdio: "inherit", env: { ...process.env, CI: "true" } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

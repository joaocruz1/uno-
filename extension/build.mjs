// Builds the extension for one UNO instance into extension/dist/<host>/ and a
// .zip ready for the Chrome Web Store.
//   node extension/build.mjs                         → produção
//   node extension/build.mjs --url http://localhost:3000
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PRODUCTION_URL = "https://unoetiquetas.company";
const root = dirname(fileURLToPath(import.meta.url));
const flag = process.argv.indexOf("--url");
const target = new URL(flag > -1 ? process.argv[flag + 1] : PRODUCTION_URL);
if (target.protocol !== "https:" && target.hostname !== "localhost" && target.hostname !== "127.0.0.1") {
  throw new Error("A UNO precisa de https (exceto localhost).");
}
const origin = target.origin;
const out = join(root, "dist", target.host.replace(/[^a-z0-9.-]/gi, "_"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "src"), join(out, "src"), { recursive: true });
cpSync(join(root, "icons"), join(out, "icons"), { recursive: true });

// Chrome match patterns take no port; the host permission still covers it.
const pattern = `${target.protocol}//${target.hostname}`;
writeFileSync(join(out, "manifest.json"), readFileSync(join(root, "manifest.json"), "utf8").replaceAll("__UNO_ORIGIN__", pattern));
writeFileSync(join(out, "src", "config.js"), readFileSync(join(root, "src", "config.js"), "utf8").replace("__UNO_URL__", origin));

const zip = `${out}.zip`;
rmSync(zip, { force: true });
execFileSync("zip", ["-qr", zip, "."], { cwd: out });
console.log(`Extensão para ${origin}\n  pasta: ${out}\n  zip:   ${zip}`);

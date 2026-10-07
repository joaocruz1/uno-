import { copyFile, cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const version = require("pdfjs-dist/package.json").version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid PDF.js version");
await mkdir(resolve("public/pdfjs"), { recursive: true });
await copyFile(require.resolve("pdfjs-dist/build/pdf.worker.min.mjs"), resolve(`public/pdfjs/pdf.worker.${version}.min.mjs`));
const packageRoot = dirname(require.resolve("pdfjs-dist/package.json"));
await Promise.all(["standard_fonts", "cmaps", "wasm"].map((folder) => cp(resolve(packageRoot, folder), resolve(`public/pdfjs/${version}/${folder}`), { recursive: true })));

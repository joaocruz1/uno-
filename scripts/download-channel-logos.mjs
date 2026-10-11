#!/usr/bin/env node
/**
 * Baixa os logos OFICIAIS dos marketplaces para public/channels/.
 *
 * Este script não contém nenhum logo: ele só baixa as URLs que VOCÊ informar.
 * A escolha da fonte é sua — use a página de marca/imprensa de cada marketplace
 * ou a Wikimedia Commons (ex.: busque "Mercado Libre logo", "Shopee logo"…).
 *
 * Uso:
 *   1) Preencha as URLs em SOURCES abaixo (SVG de preferência; PNG/WebP também servem).
 *      Ou passe por argumento:  node scripts/download-channel-logos.mjs mercado-livre="https://…/logo.svg"
 *   2) Rode:  node scripts/download-channel-logos.mjs
 *   3) Recarregue a landing — o ChannelMark troca a sigla pelo logo sozinho.
 *
 * Só escreve em public/channels/. Os arquivos baixados ficam fora do Git.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Cole aqui a URL do logo oficial de cada canal (deixe "" para pular).
const SOURCES = {
  "mercado-livre": "",
  "shopee": "",
  "amazon": "",
  "magalu": "",
  "tiktok": "",
  "tray": "",
};

const VALID_IDS = new Set(Object.keys(SOURCES));
const OUT = join(process.cwd(), "public", "channels");
const MAX_BYTES = 3 * 1024 * 1024;
const EXT_BY_TYPE = { "image/svg+xml": "svg", "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg", "image/jpg": "jpg" };

function extFromUrl(url) {
  const match = url.split(/[?#]/)[0].match(/\.(svg|png|webp|jpe?g)$/i);
  return match ? match[1].toLowerCase().replace("jpeg", "jpg") : null;
}

// Argumentos id="url" sobrescrevem SOURCES.
for (const arg of process.argv.slice(2)) {
  const eq = arg.indexOf("=");
  if (eq === -1) continue;
  const id = arg.slice(0, eq).trim();
  const url = arg.slice(eq + 1).trim();
  if (VALID_IDS.has(id)) SOURCES[id] = url;
  else console.warn(`aviso: id desconhecido "${id}" (válidos: ${[...VALID_IDS].join(", ")})`);
}

async function download(id, url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("arquivo vazio");
  if (bytes.byteLength > MAX_BYTES) throw new Error(`grande demais (${bytes.byteLength} bytes)`);

  const head = bytes.subarray(0, 400).toString("utf8");
  const looksSvg = type === "image/svg+xml" || head.includes("<svg");
  const looksRaster = bytes[0] === 0x89 || bytes[0] === 0xff || bytes.subarray(0, 4).toString("ascii") === "RIFF";
  if (!looksSvg && !looksRaster && !EXT_BY_TYPE[type]) throw new Error(`não parece uma imagem (${type || "tipo ?"})`);

  const ext = EXT_BY_TYPE[type] || extFromUrl(url) || (looksSvg ? "svg" : null);
  if (!ext) throw new Error(`não consegui determinar a extensão (${type || "?"})`);

  const file = join(OUT, `${id}.${ext}`);
  await writeFile(file, bytes);
  return { file: `${id}.${ext}`, size: bytes.byteLength };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const jobs = Object.entries(SOURCES).filter(([, url]) => url && url.trim());
  if (jobs.length === 0) {
    console.error("Nenhuma URL informada. Edite SOURCES no topo do script, ou passe id=\"url\" como argumento.");
    process.exit(1);
  }

  let ok = 0;
  for (const [id, url] of jobs) {
    try {
      const result = await download(id, url.trim());
      console.log(`ok      ${result.file}  (${result.size} bytes)`);
      ok += 1;
    } catch (error) {
      console.error(`falhou  ${id}: ${error.message}`);
    }
  }
  console.log(`\n${ok}/${jobs.length} logo(s) salvos em public/channels/. Recarregue a landing.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

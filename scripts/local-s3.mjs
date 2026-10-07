import { mkdir } from "node:fs/promises";
import S3rver from "s3rver";

if (process.env.NODE_ENV === "production") throw new Error("Local S3 emulator is development-only");
const directory = new URL("../.tmp/s3/", import.meta.url).pathname;
await mkdir(directory, { recursive: true });
const origin = new URL(process.env.APP_URL ?? "http://127.0.0.1:3100").origin;
const cors = `<CORSConfiguration><CORSRule><AllowedOrigin>${origin}</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>300</MaxAgeSeconds></CORSRule></CORSConfiguration>`;
const service = new S3rver({ address: "127.0.0.1", port: 9000, directory, silent: true, vhostBuckets: false, configureBuckets: [{ name: "uno", configs: [cors] }] });
await service.run();
console.log("Local S3 emulator listening on 127.0.0.1:9000 (synthetic development data only)");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { await service.close(); process.exit(0); });

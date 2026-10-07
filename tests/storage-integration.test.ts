import { expect, it } from "vitest";
import { getStorage } from "@/server/storage";

it.skipIf(process.env.UNO_STORAGE_INTEGRATION !== "1")("real S3 signed uploads, bounded reads and downloads preserve bytes", async () => {
  const storage = getStorage();
  const key = `synthetic-test/${crypto.randomUUID()}.pdf`;
  const bytes = Buffer.from("%PDF-1.7\nsynthetic-storage-test\n%%EOF");
  try {
    const signed = await storage.signUpload({ key, contentLength: bytes.length, contentType: "application/pdf" });
    const signedHeaders = new URL(signed.url).searchParams.get("X-Amz-SignedHeaders");
    expect(signedHeaders).toContain("content-length");
    expect(signed.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    const put = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: bytes });
    expect(put.status).toBe(200);
    expect(await storage.head(key)).toMatchObject({ contentLength: bytes.length, contentType: "application/pdf" });
    expect(await storage.getRange(key, 5)).toEqual(Buffer.from("%PDF-"));
    expect(await storage.read(key, bytes.length)).toEqual(bytes);
    await expect(storage.read(key, bytes.length - 1)).rejects.toMatchObject({ code: "file_too_large" });
    const download = await storage.signDownload(key);
    const response = await fetch(download.url);
    expect(response.ok).toBe(true);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  } finally {
    await storage.delete(key);
  }
});

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

it.skipIf(process.env.UNO_STORAGE_INTEGRATION !== "1")("real S3 server-side copy keeps the bytes and the PDF media type", async () => {
  const storage = getStorage();
  const sourceKey = `synthetic-test/${crypto.randomUUID()}/source file.pdf`;
  const targetKey = `synthetic-test/${crypto.randomUUID()}/conversion-inputs/${crypto.randomUUID()}.pdf`;
  const bytes = Buffer.from("%PDF-1.7\nsynthetic-copy-test\n%%EOF");
  try {
    await storage.putBytes(sourceKey, bytes, "application/pdf", bytes.length);
    await storage.copy(sourceKey, targetKey, "application/pdf");
    expect(await storage.head(targetKey)).toMatchObject({ contentLength: bytes.length, contentType: "application/pdf" });
    expect(await storage.read(targetKey, bytes.length)).toEqual(bytes);
    expect(await storage.read(sourceKey, bytes.length)).toEqual(bytes);
    await expect(storage.copy(`synthetic-test/${crypto.randomUUID()}.pdf`, `${targetKey}.missing`, "application/pdf"))
      .rejects.toMatchObject({ code: "upload_not_found" });
  } finally {
    await storage.delete(sourceKey);
    await storage.delete(targetKey);
  }
});

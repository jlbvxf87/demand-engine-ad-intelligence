/**
 * Downscale + re-encode an image File on the CLIENT before upload. Phone photos
 * are 2–5MB (HEIC/large JPEG), which blow past the Next server-action body limit
 * (1MB default) and Vercel's ~4.5MB function-body cap — so uploads silently fail.
 * Reference/product stills don't need full resolution, so we resize to `maxDim`
 * and re-encode to JPEG (~200–500KB). Re-encoding via canvas also normalizes
 * iPhone HEIC → JPEG and bakes in EXIF orientation so the image displays upright.
 *
 * Falls back to the original file on any error (e.g. a browser that can't decode
 * the source), so it never blocks an upload.
 */
export async function compressImage(file: File, maxDim = 1600, quality = 0.85): Promise<File> {
  if (typeof document === "undefined" || !file.type.startsWith("image/")) return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", quality));
    if (!blob) return file;
    // Keep the original if it's already smaller (e.g. a tiny PNG icon).
    if (blob.size >= file.size && file.size < 900_000) return file;
    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

import "server-only";

import { readFile } from "node:fs/promises";
import { getServiceClient } from "@/lib/supabase/server";
import { BROWSER_UA } from "@/lib/http";

/**
 * Download a video from `sourceUrl` and re-upload it to permanent Supabase
 * storage. Returns the public URL, or null on any failure.
 */
export async function persistVideoToStorage(
  sourceUrl: string,
  id: string,
): Promise<string | null> {
  try {
    const res = await fetch(sourceUrl, {
      headers: { "user-agent": BROWSER_UA },
      cache: "no-store",
      // Bounded so a hung/slow CDN fetch can't stall the caller.
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return null;
    // Don't buffer absurd payloads into a serverless function's heap.
    if (Number(res.headers.get("content-length") || 0) > 200 * 1024 * 1024) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength < 1024) return null; // truncated / error page, not a real video
    const sb = getServiceClient();
    const path = `generated/${id}.mp4`;
    const { error } = await sb.storage
      .from("ad-creatives")
      .upload(path, buffer, { contentType: "video/mp4", upsert: true });
    if (error) return null;
    const { data } = sb.storage.from("ad-creatives").getPublicUrl(path);
    return data.publicUrl;
  } catch {
    return null;
  }
}

/**
 * Upload a locally-rendered MP4 (e.g. a Remotion draft) to the same permanent
 * Supabase bucket as KIE videos, so drafts and AI videos live together and the
 * reel grid can play them identically. Returns the public URL, or null on failure.
 */
export async function uploadLocalVideo(
  localPath: string,
  id: string,
): Promise<string | null> {
  try {
    const buffer = await readFile(localPath);
    if (buffer.byteLength < 1024) return null; // empty / truncated render
    const sb = getServiceClient();
    const path = `generated/${id}.mp4`;
    const { error } = await sb.storage
      .from("ad-creatives")
      .upload(path, buffer, { contentType: "video/mp4", upsert: true });
    if (error) return null;
    const { data } = sb.storage.from("ad-creatives").getPublicUrl(path);
    return data.publicUrl;
  } catch {
    return null;
  }
}

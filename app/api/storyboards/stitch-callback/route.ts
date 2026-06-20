import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stitch worker callback. The worker POSTs when the concatenated video is ready:
 *   { storyboard_id, video_url }   (omit video_url / send error on failure)
 * Optionally gated by ?key=<STITCH_WEBHOOK_SECRET>.
 */
export async function POST(req: Request) {
  const secret = process.env.STITCH_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Stitch callback not configured" }, { status: 503 });
  }
  const url = new URL(req.url);
  if (url.searchParams.get("key") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { storyboard_id?: string; video_url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { storyboard_id, video_url } = body;
  if (!storyboard_id) return NextResponse.json({ error: "storyboard_id required" }, { status: 400 });

  try {
    const sb = getServiceClient();
    const ready = Boolean(video_url);
    const { data, error } = await sb
      .from("storyboards")
      .update({
        final_video_url: video_url ?? null,
        final_status: ready ? "ready" : "failed",
        status: ready ? "ready" : "failed",
      })
      .eq("id", storyboard_id)
      .select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, matched: data?.length ?? 0 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Callback failed" },
      { status: 500 }
    );
  }
}

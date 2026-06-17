import { getGeneratedCreatives, getStoryboards } from "@/lib/data";
import PublishClient from "./PublishClient";

export const dynamic = "force-dynamic";

export default async function PublishPage() {
  const [creatives, storyboards] = await Promise.all([
    getGeneratedCreatives(18),
    getStoryboards(8),
  ]);
  return <PublishClient creatives={creatives} storyboards={storyboards} />;
}

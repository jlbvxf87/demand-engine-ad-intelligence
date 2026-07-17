import { getGeneratedCreatives, getStoryboards } from "@/lib/data";
import SimpleCreate from "./SimpleCreate";

export const dynamic = "force-dynamic";

export default async function PublishPage() {
  const [creatives, storyboards] = await Promise.all([
    getGeneratedCreatives(200),
    getStoryboards(8),
  ]);
  return <SimpleCreate creatives={creatives} storyboards={storyboards} />;
}

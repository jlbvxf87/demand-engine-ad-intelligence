import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { isAdminAuthed } from '@/lib/admin-auth';
import { isMachineAuthed } from '@/lib/machine-auth';
import { getServiceClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type GenerationType = 'hooks' | 'ugc_script' | 'vsl_outline' | 'quiz_questions' | 'positioning';

const SYSTEM = `You are the best direct response creative director and copywriter in health vertical advertising. You write for real campaigns. You understand consumer psychology, compliance requirements, and what actually converts. Return raw JSON only.`;

function buildPrompt(type: GenerationType, ad: Record<string, unknown>): string {
  const intel = (ad.intelligence_json as Record<string, unknown>) ?? {};
  const psych = (ad.psychology_json as Record<string, unknown>) ?? (intel.psychology as Record<string, unknown>) ?? {};
  const vertical = (intel.vertical as string) ?? (ad.vertical as string) ?? 'health';
  const product = (intel.product as string) ?? (ad.page_product as string) ?? 'health program';
  const offer = (intel.offer as string) ?? (ad.page_offer as string) ?? '';
  const hookType = (intel.hook_type as string) ?? 'fear_appeal';
  const funnelType = (intel.funnel_type as string) ?? 'direct';
  const headline = (ad.page_headline as string) ?? (ad.ad_title as string) ?? '';
  const coreFear = (psych.core_fear_activated as string) ?? '';
  const coreDesire = (psych.core_desire_activated as string) ?? '';
  const identityHook = (psych.identity_hook as string) ?? '';
  const innerMonologue = (psych.inner_monologue_match as string) ?? '';
  const pageName = (ad.page_name as string) ?? 'this advertiser';
  const complianceFlags = (intel.compliance_flags as string[]) ?? [];

  const ctx = `ADVERTISER: ${pageName}
VERTICAL: ${vertical}
PRODUCT: ${product}
OFFER: ${offer}
HEADLINE OBSERVED: ${headline}
HOOK TYPE USED: ${hookType}
FUNNEL TYPE: ${funnelType}
CORE FEAR: ${coreFear}
CORE DESIRE: ${coreDesire}
IDENTITY HOOK: ${identityHook}
INNER MONOLOGUE: ${innerMonologue}
COMPLIANCE FLAGS TO AVOID: ${complianceFlags.join(', ') || 'none flagged'}`;

  if (type === 'hooks') {
    return `${ctx}

Generate 10 original ad hooks inspired by the pattern this advertiser is using. Do NOT copy their headline — create original treatments of the same psychological angle.

COMPLIANCE: No "approved/prescribed" language. No therapeutic claims. No "free" — use "complimentary." No banned CTAs (Get Started/Sign Up/Learn More).

Return JSON:
{
  "hooks": [
    {
      "hook": "the opening hook (5-10 words, scroll-stopping)",
      "bridge": "the sentence connecting hook to product",
      "cta": "outcome-framed CTA (3-5 words)",
      "angle": "one phrase: the psychological angle",
      "platform": "Meta | TikTok | Google — best fit"
    }
  ]
}`;
  }

  if (type === 'ugc_script') {
    return `${ctx}

Write a 45-60 second UGC (user-generated content) video script. First-person, authentic, relatable. NOT a polished commercial — sounds like a real person talking to camera. Uses the same psychological triggers as this advertiser.

COMPLIANCE: No "approved" language. No before/after claims without "results may vary." No therapeutic claims for peptides. Hedge eligibility language.

Return JSON:
{
  "script": {
    "hook_0_3s": "Opening line that stops the scroll — first-person, specific problem",
    "problem_3_10s": "Expand on the struggle — relatable, emotional, specific",
    "story_10_25s": "What I tried before, why it didn't work, what changed",
    "solution_25_45s": "Introduce the product/program naturally — as a discovery, not an ad",
    "cta_45_60s": "Soft call to action — where to go, what to expect",
    "b_roll_notes": "Visual suggestions for each section",
    "compliance_notes": "Any language to watch out for in this script"
  }
}`;
  }

  if (type === 'vsl_outline') {
    return `${ctx}

Create a VSL (video sales letter) outline for this product/offer. 8-12 minutes long. Direct response structure that matches the psychological profile of this advertiser's target audience.

Return JSON:
{
  "vsl": {
    "title": "VSL working title",
    "duration_estimate": "X-Y minutes",
    "sections": [
      {
        "name": "Section name",
        "duration": "0:00–0:00",
        "purpose": "What this section does psychologically",
        "key_points": ["point 1", "point 2"],
        "sample_copy": "Opening line or key phrase for this section"
      }
    ],
    "compliance_reminders": ["list of compliance items to check in final script"]
  }
}`;
  }

  if (type === 'quiz_questions') {
    return `${ctx}

Generate a 10-question quiz funnel for this offer. The quiz should:
1. Start with low-friction emotional/identity questions
2. Progress to clinical qualification questions
3. End with eligibility + lead capture
4. Use the same psychological approach as this advertiser

Return JSON:
{
  "quiz": {
    "title": "Quiz title (outcome-framed)",
    "intro_text": "1-2 sentences before question 1",
    "questions": [
      {
        "number": 1,
        "question": "Question text",
        "type": "single_select | multi_select | scale | text",
        "options": ["option 1", "option 2", "option 3"],
        "purpose": "What this question qualifies or personalizes",
        "branch_note": "Any branching logic — e.g. 'If X, route to Y'"
      }
    ],
    "completion_text": "Text shown after final question before results",
    "compliance_notes": "Questions to avoid or watch for compliance"
  }
}`;
  }

  // positioning
  return `${ctx}

Generate compliant product positioning for this offer. The original advertiser has these compliance flags: ${complianceFlags.join(', ') || 'none'}.

Create 5 positioning angles that achieve the same psychological impact while being fully compliant. Include:
- Hedged eligibility language
- No therapeutic claims
- No "approved/prescribed" framing
- Results-may-vary framing where needed
- FTC-safe testimonial framing

Return JSON:
{
  "positioning": [
    {
      "angle": "Positioning angle name",
      "headline": "Compliant headline",
      "subhead": "Supporting line",
      "cta": "Outcome-framed CTA",
      "why_compliant": "What makes this version safe",
      "psychological_impact": "How it achieves the same emotional effect as the original"
    }
  ]
}`;
}

export async function POST(req: Request) {
  if (!(await isAdminAuthed()) && !isMachineAuthed(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { ad_id, generation_type } = (await req.json()) as {
    ad_id: string;
    generation_type: GenerationType;
  };

  if (!ad_id || !generation_type) {
    return NextResponse.json({ error: 'ad_id and generation_type required' }, { status: 400 });
  }

  const supabase = getServiceClient();
  const { data: ad } = await supabase
    .from('spy_ads')
    .select('page_name, page_headline, page_product, page_offer, page_cta, vertical, intelligence_json, psychology_json, ad_title, ad_body')
    .eq('id', ad_id)
    .single();

  if (!ad) return NextResponse.json({ error: 'Ad not found' }, { status: 404 });

  const prompt = buildPrompt(generation_type, ad as Record<string, unknown>);
  const anthropic = new Anthropic();

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });

    // Find the first text block rather than assuming content[0] is text — an
    // empty/refused/non-text first block (e.g. stop_reason "refusal" returns an
    // empty content array) would otherwise make content[0] undefined and throw.
    const block = message.content.find((c) => c.type === 'text');
    const raw = block && block.type === 'text' ? block.text.trim() : '';
    if (!raw) {
      return NextResponse.json(
        { error: 'Model returned no text content (possible refusal or empty response)' },
        { status: 502 }
      );
    }

    let result: Record<string, unknown> = {};
    try {
      result = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) result = JSON.parse(match[0]);
    }

    return NextResponse.json({ generation_type, result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Generation failed' }, { status: 500 });
  }
}

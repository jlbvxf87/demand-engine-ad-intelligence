import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { isAdminAuthed } from '@/lib/admin-auth';
import { isMachineAuthed } from '@/lib/machine-auth';
import { getServiceClient } from '@/lib/supabase/server';
import { toSiteUrl } from '@/lib/url';
import { unsafeFetchReason } from "@/lib/ssrf";
import { BROWSER_UA } from "@/lib/http";

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SYSTEM_PROMPT = `You are a direct response intelligence analyst who thinks like the best black-market advertiser in the world — someone who has spent $100M+ on Meta ads in health verticals and understands consumer psychology at a clinical level.

You analyze competitor landing pages for a patient acquisition platform in GLP-1 weight loss, TRT, peptides, and joint pain.

---

CONSUMER PSYCHOLOGY FRAMEWORK

Eugene Schwartz's 5 Levels of Awareness — you identify which level this page targets:
- unaware: consumer doesn't know they have a problem
- problem_aware: knows the problem, doesn't know solutions exist → educate + activate hope
- solution_aware: knows solutions exist, hasn't chosen one → differentiate + prove
- product_aware: knows this product, hasn't bought → handle objections + urgency
- most_aware: ready to buy, needs a reason now → offer + risk removal

Cold Meta traffic almost always enters at problem_aware. Advertorials move them to solution_aware. Quizzes move them to product_aware. VSLs close most_aware.

Core psychological triggers that move health consumers:
- loss_aversion: fear of staying the same outweighs fear of change ("every month you wait is another month of...")
- identity_shift: consumer sees themselves as a different person after buying ("the kind of person who...")
- social_proof_peer: people like me got results (not celebrity, not doctor — peer)
- social_proof_authority: doctor/provider/institution validates
- in_group_access: this solution isn't for everyone, only people who qualify
- permission_mechanism: internal justification to buy ("it's medical, not giving up")
- sunk_cost_hope: "I've tried everything" → "but this is different because..."
- future_pacing: vivid picture of life after the transformation
- scarcity_real: limited provider slots, waitlist, genuine capacity constraint
- scarcity_fake: countdown timers, "offer ends" with no real expiry
- price_anchor_high: show expensive alternative first to make your price feel small
- risk_reversal: money-back guarantee removes the last objection

Vertical-specific core fears and desires:

GLP-1:
- Core fear: "My body is broken. I'll never lose this weight. Every diet has failed."
- Core desire: "I want my body back. I want to stop being embarrassed. I want to feel normal."
- Identity hook: "Smart people use medical tools, not willpower."
- Permission: "This isn't giving up — this is working with your biology, not against it."
- Inner monologue: "What if this is the thing that actually works for people like me?"

TRT:
- Core fear: "I'm becoming less of a man. My wife notices. My drive is gone. Is this just aging?"
- Core desire: "I want energy, confidence, sex drive, and focus back. I want to feel 35 again."
- Identity hook: "Optimized men don't accept decline as inevitable."
- Permission: "It's correcting a deficiency — same as a diabetic taking insulin. It's responsible."
- Inner monologue: "Other men my age don't feel this way. Something is medically wrong."

Peptides:
- Core fear: "This injury isn't healing. I'm going to lose my edge. Surgery will sideline me for months."
- Core desire: "Get back faster than anyone expects. Recover like an elite athlete."
- Identity hook: "The top 1% of performers optimize recovery, not just training."
- Permission: "This is the same science military special forces and pro athletes use."
- Inner monologue: "I'll do whatever it takes to get back to where I was."

Joint pain:
- Core fear: "I'm heading toward surgery. I'll be sidelined. I won't be able to keep up."
- Core desire: "Stay active. Play with grandkids. Keep hiking/cycling/living."
- Identity hook: "Informed patients exhaust every option before committing to something irreversible."
- Permission: "A second opinion is smart, not indecisive."
- Inner monologue: "What if there's something I don't know about that could help before I commit to surgery?"

---

COMPETITIVE LANDSCAPE

Tier 1 ($1M–$20M/mo Meta spend): Hims/Hers, Gameday (~15K ads, TRT+GLP-1 bundle), Fridays ($150/mo flat-rate disruptor, 4,300 ads), WeightWatchers/Noom
Tier 2 ($50K–$1.5M/mo): Beyond the Scale (transformation narratives, #1 scroll-frequency), LifeRx.md, Blue Haven RX, Midi Health, Fountain TRT (31+ steps, 15+ interstitials, $35 eval entry)
Tier 3 (<$50K/mo): Single clinics, early brands

Winner signal: Brands running 50+ ads for 90+ days with high spend are proven converters. Study them deeply.

HIGH-CONVERTING PATTERNS:
- Motivation-first (outcome framing before clinical questions)
- Interstitial pacing every 2-3 steps ("analyzing your responses...")
- Personalized computed recommendation vs generic menu
- PII captured AFTER positive eligibility signal
- Outcome-framed CTAs: "Reserve Your Spot" "Find My Treatment" "Start My Program"
- Two-plan pricing ladder (one differentiator)
- Named before/after with specific metrics
- Narrow money-back guarantee (if provider determines not eligible)
- Trust stack: media logos + provider creds + verified reviews + LegitScript

COMPLIANCE (critical to note violations):
Required hedging: "may be a good fit" "strong candidate" "subject to clinician approval"
Banned: "You are approved" "You have been prescribed" "cures/treats/heals"
FTC: advertorials need "Sponsored Content" disclosure
Required at checkout: FDA disclaimer, results-vary, HIPAA

---

Your output is a valid JSON object. No markdown. No code fences. Raw JSON only.`;

export async function POST(req: Request) {
  if (!(await isAdminAuthed()) && !isMachineAuthed(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { ad_id, url: providedUrl } = (await req.json()) as { ad_id: string; url?: string };
  if (!ad_id) return NextResponse.json({ error: 'ad_id is required' }, { status: 400 });

  const supabase = getServiceClient();

  const { data: adRow } = await supabase
    .from('spy_ads')
    .select('destination_url, spend_lower, spend_upper, impressions_lower, impressions_upper, delivery_start_time, days_running, winner_score, brand_ad_count, page_name')
    .eq('id', ad_id)
    .single();

  // Destinations are often stored without a scheme (e.g. "www.endthewaitpa.com",
  // "glp.diet") — normalize to a fetchable https URL, and reject non-URL captions.
  const url = toSiteUrl(providedUrl || adRow?.destination_url);
  if (!url) {
    await supabase.from('spy_ads').update({ crawl_status: 'error' }).eq('id', ad_id);
    return NextResponse.json(
      { error: "No crawlable landing-page URL for this ad — its destination isn't a real link." },
      { status: 400 },
    );
  }

  const unsafe = unsafeFetchReason(url);
  if (unsafe) {
    await supabase.from('spy_ads').update({ crawl_status: 'error' }).eq('id', ad_id);
    return NextResponse.json({ error: `Can't crawl that URL — ${unsafe}` }, { status: 400 });
  }

  await supabase.from('spy_ads').update({ crawl_status: 'crawling' }).eq('id', ad_id);

  try {
    const pageRes = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(12000),
    });

    const html = (await pageRes.text()).slice(0, 28000);

    const spendCtx = adRow?.spend_lower != null
      ? `Meta reported spend: $${adRow.spend_lower.toLocaleString()}–$${(adRow.spend_upper ?? 0).toLocaleString()} USD. Impressions: ${(adRow.impressions_lower ?? 0).toLocaleString()}–${(adRow.impressions_upper ?? 0).toLocaleString()}. Running ${adRow.days_running ?? 0} days. Winner score: ${adRow.winner_score ?? 0}. Brand ad count in search: ${adRow.brand_ad_count ?? 1}.`
      : 'Meta spend data not available.';

    const anthropic = new Anthropic();

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3500,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Analyze this competitor landing page from ${adRow?.page_name ?? 'unknown advertiser'}.

META SPEND CONTEXT:
${spendCtx}

Return this exact JSON structure (raw JSON only):
{
  "headline": "main H1 or most prominent headline",
  "product": "what is being sold",
  "offer": "the specific offer",
  "cta": "primary call-to-action button text",
  "pricing": "any pricing info visible, or null",
  "vertical": "glp1 | trt | peptides | joint_pain | weight_loss | other",
  "funnel_type": "advertorial | quiz | vsl | direct | consultation | hybrid",
  "offer_type": "consult | rx_subscription | evaluation_fee | lead_gen | product_purchase | unknown",
  "cta_pattern": "outcome_framed | transactional | hybrid",
  "pricing_structure": "single_plan | two_plan_ladder | tiered | subscription_toggle | hidden | none_visible",
  "trust_signals": ["media_logos", "reviews", "provider_creds", "money_back", "hipaa", "legit_script", "before_after", "testimonials"],
  "compliance_flags": ["approved_language", "therapeutic_claim", "missing_fda_disclaimer", "no_advertorial_disclosure", "banned_cta"] or [],
  "interstitial_strategy": "none | light | heavy | unknown",
  "urgency_mechanism": "countdown_timer | scarcity | discount_anchor | promo_code | none",
  "hook_type": "transformation_narrative | price_anchor | comparison_rebuttal | data_stats | persona_story | fear_appeal | authority",
  "lead_capture_timing": "upfront | post_personalization | post_approval | unknown",
  "competitor_tier": "tier1_dominant | tier2_midmarket | tier3_clinic | unknown",
  "conversion_strength": "weak | moderate | strong | dominant",
  "spend_signal_assessment": "testing | scaling | dominant | paused | unknown",
  "psychology": {
    "consumer_awareness_level": "unaware | problem_aware | solution_aware | product_aware | most_aware",
    "core_fear_activated": "the exact fear this page triggers in the consumer — be specific, first-person",
    "core_desire_activated": "the exact desire this page taps — be specific, first-person",
    "identity_hook": "who the consumer sees themselves as when they choose to buy",
    "permission_mechanism": "the internal justification the consumer is given to make the purchase feel right",
    "psychological_triggers": ["loss_aversion", "identity_shift", "social_proof_peer", "social_proof_authority", "in_group_access", "permission_mechanism", "future_pacing", "scarcity_real", "scarcity_fake", "price_anchor_high", "risk_reversal"],
    "objections_handled": ["list the specific objections this page preemptively handles"],
    "inner_monologue_match": "the exact sentence the consumer says to themselves that this page answers — quote it as if you are the consumer"
  },
  "summary": "2-3 sentences: what they sell, who they target, what psychological lever moves the sale",
  "market_intelligence": "2-3 sentences: what this page reveals about the market, what they do better or worse than top performers, what specific opportunity this signals for a competing funnel",
  "hook_analysis": {
    "hook_type": "newsjacking | fear_transfer | identity_challenge | authority_reveal | contrarian | social_proof_surge | curiosity_gap | status_quo_threat | silent_epidemic | transformation_before_after | other",
    "emotional_trigger": "the specific real-world fear, trend, or desire being used as the entry point — be precise",
    "bridge_mechanism": "exactly how they connect the hook/trigger to the product — the logical or emotional leap they make",
    "visual_technique": "disaster_composite | ugc_testimonial | text_on_lifestyle | split_before_after | news_graphic | clinical_scene | product_hero | person_reaction | other",
    "copy_structure": {
      "step1": "what the first element does psychologically",
      "step2": "what the second element does",
      "step3": "what the third element does",
      "step4": "how it closes"
    },
    "hook_sentence": "the exact opening hook or headline this ad/page uses",
    "bridge_text": "the sentence that connects the hook to the product",
    "why_it_works": "1-2 sentences: the psychological reason this specific hook-to-product connection is effective for this audience"
  }
}

HTML:
${html}`,
      }],
    });

    const block = message.content.find((c) => c.type === 'text');
    const rawText = block && block.type === 'text' ? block.text.trim() : '';
    if (!rawText) {
      await supabase.from('spy_ads').update({ crawl_status: 'error' }).eq('id', ad_id);
      return NextResponse.json(
        { error: 'The analysis model returned an empty response — nothing to parse.' },
        { status: 502 },
      );
    }
    let intel: Record<string, unknown> = {};
    try {
      intel = JSON.parse(rawText);
    } catch {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) intel = JSON.parse(match[0]);
    }

    const screenshot_url = `https://image.thum.io/get/width/1280/crop/900/noanimate/${encodeURIComponent(url)}`;

    await supabase.from('spy_ads').update({
      crawl_status: 'done',
      page_headline:    (intel.headline as string)          ?? null,
      page_product:     (intel.product as string)           ?? null,
      page_offer:       (intel.offer as string)             ?? null,
      page_cta:         (intel.cta as string)               ?? null,
      page_pricing:     (intel.pricing as string)           ?? null,
      page_ai_summary:  (intel.summary as string)           ?? null,
      page_screenshot_url: screenshot_url,
      vertical:         (intel.vertical as string)          ?? null,
      competitor_tier:  (intel.competitor_tier as string)   ?? null,
      conversion_strength: (intel.conversion_strength as string) ?? null,
      intelligence_json: intel,
      psychology_json:  (intel.psychology as object)        ?? null,
      crawled_at: new Date().toISOString(),
    }).eq('id', ad_id);

    // Save hook pattern for proven winners (winner_score > 1500)
    const hookAnalysis = intel.hook_analysis as Record<string, unknown> | undefined;
    if (hookAnalysis && (adRow?.winner_score ?? 0) > 1500) {
      const domain = (() => { try { return new URL(url).hostname.replace('www.', ''); } catch { return url; } })();
      await supabase.from('ad_hook_patterns').insert({
        spy_ad_id: ad_id,
        source_url: url,
        source_brand: adRow?.page_name ?? null,
        source_domain: domain,
        hook_type: hookAnalysis.hook_type as string ?? 'other',
        emotional_trigger: hookAnalysis.emotional_trigger as string ?? null,
        bridge_mechanism: hookAnalysis.bridge_mechanism as string ?? null,
        visual_technique: hookAnalysis.visual_technique as string ?? null,
        copy_structure: hookAnalysis.copy_structure ?? null,
        hook_sentence: hookAnalysis.hook_sentence as string ?? null,
        bridge_text: hookAnalysis.bridge_text as string ?? null,
        cta_text: (intel.cta as string) ?? null,
        why_it_works: hookAnalysis.why_it_works as string ?? null,
        vertical: (intel.vertical as string) ?? null,
        winner_score: adRow?.winner_score ?? 0,
      });
    }

    return NextResponse.json({ intelligence: intel, screenshot_url });
  } catch (err) {
    await supabase.from('spy_ads').update({ crawl_status: 'error' }).eq('id', ad_id);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Crawl failed' }, { status: 500 });
  }
}

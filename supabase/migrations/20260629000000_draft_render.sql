-- Cheap "Draft" render path (Remotion + FFmpeg) lives alongside the KIE video
-- pipeline. Draft creatives are marked render_mode='draft', video_provider='remotion',
-- and carry NO t2v_job_id, so the KIE poller (pollVideoJobs, filtered on
-- t2v_job_id is not null) ignores them. render_plan_json stores the DraftRenderPlan
-- the worker rendered, so a draft can later be re-rendered or upgraded.

alter table public.ad_creatives
  add column if not exists render_mode      text,   -- draft | motion | cinematic | null (KIE)
  add column if not exists render_plan_json jsonb;  -- the DraftRenderPlan used to render

create index if not exists ad_creatives_render_mode_idx
  on public.ad_creatives (render_mode);

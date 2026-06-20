-- Track how many times a clip has been submitted to render, so the storyboard
-- reconciler can SELF-HEAL a failed scene (re-render just that clip) a bounded
-- number of times instead of either giving up or looping forever.
--
-- Idempotent / re-runnable.

alter table public.ad_creatives
  add column if not exists video_attempts int not null default 0;

comment on column public.ad_creatives.video_attempts is
  'Render submit attempts for this clip. Bounds storyboard scene self-heal retries.';

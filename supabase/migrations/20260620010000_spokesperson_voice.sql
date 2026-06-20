-- Spokesperson (lip-synced voice) render is a 2-stage Kie job: TTS the script,
-- then lip-sync that audio onto the still. These columns track the stage and the
-- intermediate voiceover audio. Idempotent / re-runnable.

alter table public.ad_creatives
  add column if not exists render_stage text,
  add column if not exists tts_job_id text,
  add column if not exists vo_audio_url text;

comment on column public.ad_creatives.render_stage is
  'Spokesperson 2-stage render: tts | lipsync | null (normal/done).';

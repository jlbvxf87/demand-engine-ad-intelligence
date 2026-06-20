-- Make ad ingestion idempotent at the DATABASE level.
--
-- Why: the search route dedupes by SELECT-ing existing meta_ad_ids and inserting
-- only the new ones. Two searches running at the same time can both pass that
-- check for the same ad and both insert it → duplicate spy_ads rows. App-level
-- read dedup (dedupeByMetaId) papers over the symptom but wastes storage and can
-- skew the "N× ads" grouping. A UNIQUE index makes the DB reject the second
-- insert atomically, so the race simply can't produce a dup.
--
-- The application is already written to cooperate with this index:
--   • search route inserts via UPSERT ... ON CONFLICT (meta_ad_id) DO NOTHING
--     (falls back to a plain insert if this index isn't applied yet)
--   • source-link route treats a 23505 conflict as "already in library"
-- so it is safe to deploy the code before OR after running this migration.
--
-- This migration is idempotent and can be re-run safely.

BEGIN;

-- 1. Collapse any duplicates that already exist, keeping the earliest row per
--    meta_ad_id. First detach dependent hook-pattern rows belonging to the
--    losing duplicates (they're re-derived on the next Decode), guarded so this
--    is a no-op if the table doesn't exist. This avoids an FK error during the
--    delete regardless of how the FK's ON DELETE is configured.
DO $$
BEGIN
  IF to_regclass('public.ad_hook_patterns') IS NOT NULL THEN
    DELETE FROM ad_hook_patterns p
    USING (
      SELECT id,
             row_number() OVER (PARTITION BY meta_ad_id ORDER BY created_at ASC, id ASC) AS rn
      FROM spy_ads
      WHERE meta_ad_id IS NOT NULL
    ) ranked
    WHERE p.spy_ad_id = ranked.id AND ranked.rn > 1;
  END IF;
END $$;

WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY meta_ad_id ORDER BY created_at ASC, id ASC) AS rn
  FROM spy_ads
  WHERE meta_ad_id IS NOT NULL
)
DELETE FROM spy_ads s
USING ranked r
WHERE s.id = r.id AND r.rn > 1;

-- 2. Enforce uniqueness going forward. A plain (non-partial) unique index:
--    Postgres treats NULLs as distinct, so any rows without a Meta ad id are
--    never blocked, AND `ON CONFLICT (meta_ad_id)` can infer this index (a
--    PARTIAL index would NOT match that inference, forcing the app's upsert to
--    fall back to lossy plain inserts on conflict — so it must stay non-partial).
CREATE UNIQUE INDEX IF NOT EXISTS spy_ads_meta_ad_id_key
  ON spy_ads (meta_ad_id);

COMMIT;

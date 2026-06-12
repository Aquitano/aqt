-- Replace the eagerly materialized structural canonical tables with rank-based views.
-- provider_ranks (seeded in V14 and re-upserted at startup) is the single rank source.
-- canonical_step_samples and canonical_step_day_bucket_contributions stay materialized
-- (interval dedup and bucket splitting are genuinely heavy), as do step_daily_summaries
-- and sleep_nights themselves.

DROP TABLE canonical_activity_summaries;
CREATE VIEW canonical_activity_summaries AS
SELECT DISTINCT ON (a.date) a.id,
                            a.date,
                            a.source_instance_id,
                            a.id AS activity_summary_id
FROM activity_summaries a
         JOIN source_instances si ON si.id = a.source_instance_id
         JOIN sources src ON src.id = si.source_id
         LEFT JOIN provider_ranks pr
                   ON pr.family = 'activity' AND pr.provider_code = src.code
ORDER BY a.date, COALESCE(pr.rank, 10000), a.id DESC;

DROP TABLE canonical_step_daily_summaries;
CREATE VIEW canonical_step_daily_summaries AS
SELECT DISTINCT ON (d.date) d.id,
                            d.date,
                            d.source_instance_id,
                            d.id AS step_daily_summary_id,
                            d.steps
FROM step_daily_summaries d
         JOIN source_instances si ON si.id = d.source_instance_id
         JOIN sources src ON src.id = si.source_id
         LEFT JOIN provider_ranks pr
                   ON pr.family = 'steps' AND pr.provider_code = src.code
ORDER BY d.date, COALESCE(pr.rank, 10000), d.sample_count DESC, d.steps DESC, d.source_instance_id;

DROP TABLE canonical_sleep_summaries;
CREATE VIEW canonical_sleep_summaries AS
SELECT DISTINCT ON (((s.start_at AT TIME ZONE 'UTC')::date)) s.id,
                                                             (s.start_at AT TIME ZONE 'UTC')::date AS date,
                                                             s.source_instance_id,
                                                             s.id AS sleep_summary_id,
                                                             s.start_at,
                                                             s.end_at
FROM sleep_summaries s
         JOIN source_instances si ON si.id = s.source_instance_id
         JOIN sources src ON src.id = si.source_id
         LEFT JOIN provider_ranks pr
                   ON pr.family = 'sleep_summary' AND pr.provider_code = src.code
ORDER BY ((s.start_at AT TIME ZONE 'UTC')::date), COALESCE(pr.rank, 10000), s.id DESC;

-- Window variant: the winning provider per UTC start date keeps ALL its sessions, so naps
-- from the same device are preserved while a colliding lower-ranked provider is dropped.
DROP TABLE canonical_sleep_sessions;
CREATE VIEW canonical_sleep_sessions AS
SELECT id, date, source_instance_id, sleep_session_id, start_at, end_at
FROM (SELECT s.id,
             (s.start_at AT TIME ZONE 'UTC')::date           AS date,
             s.source_instance_id,
             s.id                                            AS sleep_session_id,
             s.start_at,
             s.end_at,
             COALESCE(pr.rank, 10000)                        AS provider_rank,
             MIN(COALESCE(pr.rank, 10000)) OVER (
                 PARTITION BY (s.start_at AT TIME ZONE 'UTC')::date
                 )                                           AS best_rank
      FROM sleep_sessions s
               JOIN source_instances si ON si.id = s.source_instance_id
               JOIN sources src ON src.id = si.source_id
               LEFT JOIN provider_ranks pr
                         ON pr.family = 'sleep' AND pr.provider_code = src.code) ranked
WHERE provider_rank = best_rank;

DROP TABLE canonical_sleep_nights;
CREATE VIEW canonical_sleep_nights AS
SELECT id, date, timezone, source_instance_id, sleep_session_id
FROM (SELECT n.id,
             n.date,
             n.timezone,
             n.source_instance_id,
             n.sleep_session_id,
             COALESCE(pr.rank, 10000) AS provider_rank,
             MIN(COALESCE(pr.rank, 10000)) OVER (
                 PARTITION BY n.date, n.timezone
                 )                    AS best_rank
      FROM sleep_nights n
               JOIN source_instances si ON si.id = n.source_instance_id
               JOIN sources src ON src.id = si.source_id
               LEFT JOIN provider_ranks pr
                         ON pr.family = 'sleep' AND pr.provider_code = src.code) ranked
WHERE provider_rank = best_rank;

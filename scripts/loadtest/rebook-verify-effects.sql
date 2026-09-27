-- rebook-ai F5 exactly-one-effect verification (milestones.md §F5:
-- "N-way confirm concurrency with exactly-one-effect verified").
--
-- The runner passes the confirmed-under-load offer ids as a CSV list (:ids)
-- and prints one machine-readable row per invariant. The offer pipeline is
-- the source of truth here — HTTP status codes alone prove nothing
-- (data-ethics.md §4: effects are counted where they land).
--
-- Usage:
--   docker compose exec -T postgres psql -U turnaround -d rebook_ai \
--     -v ids="<uuid,uuid,...>" -f - < scripts/loadtest/rebook-verify-effects.sql

\echo 'exactly-one-effect verification'
SELECT 'test_offers' AS invariant, count(*)::text AS value
FROM offers WHERE id::text = ANY (string_to_array(:'ids', ',')::text[])
UNION ALL
-- exactly one confirmation row per offer
SELECT 'confirmations_gt1', count(*)::text FROM (
  SELECT offer_id FROM confirmations
  WHERE offer_id::text = ANY (string_to_array(:'ids', ',')::text[])
  GROUP BY offer_id HAVING count(*) > 1) x
UNION ALL
-- exactly one saga per offer
SELECT 'sagas_gt1', count(*)::text FROM (
  SELECT offer_id FROM sagas
  WHERE offer_id::text = ANY (string_to_array(:'ids', ',')::text[])
  GROUP BY offer_id HAVING count(*) > 1) x
UNION ALL
-- exactly one landed payment per offer (the exactly-one-charge core)
SELECT 'payment_landed_ne1', count(*)::text FROM (
  SELECT s.offer_id FROM sagas s
  JOIN saga_steps st ON st.saga_id = s.id AND st.step = 'payment' AND st.state = 'done'
  WHERE s.offer_id::text = ANY (string_to_array(:'ids', ',')::text[])
  GROUP BY s.offer_id HAVING count(*) <> 1) x
UNION ALL
-- exactly one boarding pass issued per offer (booking.issued aggregates on
-- the saga id — payload carries sagaId/pnrId, api-contracts.md §2)
SELECT 'booking_issued_ne1', count(*)::text FROM (
  SELECT s.offer_id FROM sagas s
  JOIN event_log e ON e.type = 'booking.issued' AND e.aggregate_id = s.id
  WHERE s.offer_id::text = ANY (string_to_array(:'ids', ',')::text[])
  GROUP BY s.offer_id HAVING count(*) <> 1) x
UNION ALL
-- zero landed payments at all means a phase silently no-op'd — catch it
SELECT 'payment_landed_zero', count(*)::text FROM (
  SELECT s.offer_id FROM sagas s
  WHERE s.offer_id::text = ANY (string_to_array(:'ids', ',')::text[])
    AND NOT EXISTS (
      SELECT 1 FROM saga_steps st
      WHERE st.saga_id = s.id AND st.step = 'payment' AND st.state = 'done')) x
UNION ALL
-- every saga reached a terminal state (none stuck/failed)
SELECT 'sagas_not_completed', count(*)::text FROM sagas
WHERE offer_id::text = ANY (string_to_array(:'ids', ',')::text[])
  AND state <> 'completed'
UNION ALL
-- exactly one audit row per offer confirm (api-contracts.md §5 audit completeness)
SELECT 'audit_confirm_ne1', count(*)::text FROM (
  SELECT target_id FROM audit_events
  WHERE action = 'offer.confirmed'
    AND target_id::text = ANY (string_to_array(:'ids', ',')::text[])
  GROUP BY target_id HAVING count(*) <> 1) x;

\echo 'offer ids under test (count + sample)'
SELECT count(*) AS offers_tested,
       min(created_at) AS first_confirm, max(created_at) AS last_confirm
FROM confirmations
WHERE offer_id::text = ANY (string_to_array(:'ids', ',')::text[]);

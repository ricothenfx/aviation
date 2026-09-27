-- rebook-ai F5 load fixtures: ×10 disruption scale via deterministic replica
-- banks (milestones.md §F5 "offer pipeline at ×10 disruption scale").
--
-- Definition of ×10 (recorded in load-report-f5.md): the reference day's
-- rebookable slice — the 5 scheduled flights whose destinations have rebookable
-- inventory (NX 288/203/206/209/212, 25 PNRs) — cloned into :banks replica
-- banks with suffixed flight numbers (e.g. "NX 288-R7") and bank-lettered
-- locators (bank 3 + "NXQ4ZK" → "cXQ4ZK"; agent-view locators are constrained
-- to 6 chars, queueSnapshotViewSchema). banks=10 ⇒ 50 disrupted flights /
-- 250 disrupted PNRs in one wave, 10× the reference rebookable disruption scale.
--
-- A bank-letter + last-5 locator COLLIDING with an existing locator violates
-- the unique index and aborts loudly — the fixtures refuse to silently merge.
--
-- Properties (honesty per data-ethics.md §4):
-- - Load-only data: never written by seed.ts, never committed fixtures; the
--   teardown is a plain `docker compose --profile rebook down -v`.
-- - Replica PNRs have user_id NULL (background synthetic bookings, schema
--   comment in apps/rebook-ai/src/db/schema.ts) so the demo cast's views stay
--   clean; confirms during the load run therefore go through the agent path.
-- - The orchestrator ranks offers from the COMMITTED inventory fixture
--   (handlers.ts loadInventory) — unchanged by replication, exactly as the
--   CI gates run.
--
-- Usage (the runner invokes this; manual use for debugging):
--   docker compose exec -T postgres psql -U turnaround -d rebook_ai \
--     -v banks=10 -f - < scripts/loadtest/rebook-scale-fixtures.sql

\echo 'scale fixtures: guarding against a dirty stack'
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM flights WHERE flight_no LIKE '%-R%') THEN
    RAISE EXCEPTION 'replica banks already present — run on a fresh stack (docker compose --profile rebook down -v && up -d)';
  END IF;
END
$$;

CREATE TEMP TABLE load_src_flights AS
  SELECT * FROM flights
  WHERE flight_no IN ('NX 288', 'NX 203', 'NX 206', 'NX 209', 'NX 212')
    AND status = 'scheduled';

CREATE TEMP TABLE load_src_pnrs AS
  SELECT DISTINCT p.*
  FROM pnr p
  JOIN pnr_segments s ON s.pnr_id = p.id
  WHERE s.flight_no IN (SELECT flight_no FROM load_src_flights);

\echo 'scale fixtures: cloning flights'
INSERT INTO flights (airline, flight_no, origin, dest, sched_dep, sched_arr, aircraft, status)
SELECT f.airline, f.flight_no || '-R' || b, f.origin, f.dest, f.sched_dep, f.sched_arr, f.aircraft, 'scheduled'
FROM load_src_flights f CROSS JOIN generate_series(1, :'banks'::int) AS b;

\echo 'scale fixtures: cloning PNRs (user_id NULL — load-run background bookings)'
INSERT INTO pnr (locator, user_id, passenger_name, tier, fare_class, contact_handle, party_size, document)
SELECT chr(96 + b) || right(p.locator, 5), NULL, p.passenger_name, p.tier, p.fare_class,
       p.contact_handle, p.party_size, p.document
FROM load_src_pnrs p CROSS JOIN generate_series(1, :'banks'::int) AS b;

\echo 'scale fixtures: cloning segments (the source-flight segment remaps to its replica)'
INSERT INTO pnr_segments (pnr_id, airline, flight_no, flight_date, origin, dest, cabin, status)
SELECT np.id, s.airline,
       CASE WHEN s.flight_no IN (SELECT flight_no FROM load_src_flights)
            THEN s.flight_no || '-R' || b ELSE s.flight_no END,
       s.flight_date, s.origin, s.dest, s.cabin, 'confirmed'
FROM generate_series(1, :'banks'::int) AS b
JOIN pnr op ON op.id IN (SELECT id FROM load_src_pnrs)
JOIN pnr np ON np.locator = chr(96 + b) || right(op.locator, 5)
JOIN pnr_segments s ON s.pnr_id = op.id;

\echo 'scale fixtures: cloning the fulfillment seat ledger'
INSERT INTO inventory_seats (flight_no, seats_left)
SELECT i.flight_no || '-R' || b, i.seats_left
FROM inventory_seats i CROSS JOIN generate_series(1, :'banks'::int) AS b
WHERE i.flight_no IN (SELECT flight_no FROM load_src_flights)
ON CONFLICT (flight_no) DO NOTHING;

\echo 'scale fixtures: summary'
SELECT (SELECT count(*) FROM flights WHERE flight_no LIKE '%-R%') AS replica_flights,
       (SELECT count(*) FROM pnr WHERE locator LIKE 'R%-') AS replica_pnrs,
       (SELECT count(*) FROM pnr_segments s JOIN pnr p ON p.id = s.pnr_id
         WHERE p.locator LIKE 'R%-') AS replica_segments;

# Data Ethics & Honesty Policy

| Field | Value |
|---|---|
| Status | Binding (decision D-07) |
| Applies to | All projects, demos, READMEs, CV claims |

## 1. Data Provenance — Allowed Sources Only

| Dataset | Use | Terms |
|---|---|---|
| Hand-written synthetic scenarios | Primary source for all operational data (flights, tasks, passengers, PNR-like records) | Original work |
| NASA C-MAPSS (Turbofan Engine Degradation Simulation) | mro-copilot engine health / RUL model | Public, freely usable with citation (Saxena & Goebel, 2008) |
| OpenSky Network historical data | Optional realism reference for flight patterns | Research terms — check attribution requirements at download time |
| OurAirports.com | Airport/gate reference data | Public domain |

**Prohibited:** scraping or importing proprietary operational data (real PNRs, DCS dumps,
real airline schedules presented as real), any personally identifiable data, any dataset
whose license is unverified.

## 2. Labeling

- Every app screen shows a persistent, visible disclaimer: **"Simulated data for portfolio purposes."**
- READMEs state which parts are simulated vs derived from public datasets, and how the simulator generates the rest.
- Generated entities use fictional brands: airlines (`NX NordicX`, `SV Sentosa Air` — invented), flight numbers in clearly fictional blocks, invented tail numbers. Never reproduce real airline liveries/names as if operational.

## 3. Affiliation & Branding

- Never claim affiliation with, endorsement from, or employment at any real company (Changi, SIA, SATS, etc.).
- No real company logos. Inspired-by naming must stay clearly distinct ("turnaround-iq", not "Changi Ops").
- Demo scripts must not imply the product is deployed anywhere real.

## 4. Metrics Honesty

- Every benchmark/number shown in a demo or README must be reproducible by a committed script (`scripts/benchmarks/`) or scenario seed.
- Report bad results alongside good ones (e.g., "replan engine misses X% of wide-body constraints — documented limitation").
- No invented "saved US$2M" business claims. Frame as scenario outcomes: "in this simulated scenario, total delay dropped from 47 to 9 minutes."

## 5. Security Hygiene

- No secrets in the repo. `.env` gitignored; `.env.example` documents required variables.
- Demo accounts are fake from birth (seeded), no real emails.
- If any real data is ever found in the repo: immediate purge + note in decision log (incident entry).

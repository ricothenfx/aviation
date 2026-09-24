# Market Research — Singapore Aviation Employer Landscape

| Field | Value |
|---|---|
| Status | Active — snapshot reference for portfolio alignment |
| Snapshot date | 2026-09-22 (verified via live fetch of career portals) — **re-verified 2026-09-24 (F5): no material change** |
| Caveat | Job listings change weekly. Re-verify before each application. Links are the source of truth, not the tables below. |

## 1. Purpose

Identify which Singapore aviation companies hire software/application engineers, what
technologies they demand, and which of the 3 portfolio projects maps to which employer.
This document justifies every product decision in the portfolio; see `traceability-matrix.md`.

## 2. Company Landscape

| Category | Companies | SWE hiring relevance | Career portal |
|---|---|---|---|
| Airport operator | Changi Airport Group (CAG), Changi Airports International | **High** — active hiring, Changi Digital Factory division | jobs.changiairport.com/cag |
| Regulator / ANS | CAAS (Civil Aviation Authority of Singapore) | Medium — smaller tech org, UAS/ATM focus | caas.gov.sg/careers |
| Airlines | Singapore Airlines (SIA), Scoot | **High** — IT division + Customer Experience roles | careers.singaporeair.com/sia, techcareers.singaporeair.com.sg |
| Ground handling / cargo | SATS (incl. WFS), dnata Singapore | High | sats.com.sg/careers + MyCareersFuture/LinkedIn |
| MRO | SIA Engineering Co (SIAEC), ST Engineering Aerospace, Jet Aviation (Seletar), ExecuJet, Bombardier SG, Fokker Services Asia | **High** — ST Engineering alone lists ~127 software roles in SG | careers.stengg.com, careers.singaporeair.com/sia |
| OEM / engines | Airbus Asia (regional HQ), Rolls-Royce (Seletar), Pratt & Whitney, GE Aerospace, Boeing | Medium — Boeing currently only ~2 SG openings; RR/GE focus on data/digital | jobs.airbus.com, careers.rolls-royce.com, jobs.boeing.com |
| Aviation IT / travel tech | SITA (APAC hub), Amadeus, Sabre, Travelport, IBS Software | **High** — routine SWE hiring | sita.aero/careers, careers.amadeus.com |
| Drones / emerging | Wing (Alphabet), H3 Dynamics, Avetics; note: Jetstar Asia ceased 2025-07, Volocopter insolvent/acquired | Niche | — |
| Associations / events | AAIS, Singapore Airshow (Experia Events) | Networking channel only | — |

## 3. Verified Openings Snapshot (2026-09-22; re-verified 2026-09-24)

> Re-verification 2026-09-24 (F5): CAG still lists 13 tech-related openings —
> Senior Software Engineer, Machine Learning Engineer, Full Stack Developer,
> Data Engineering & IoT, Airside Automation, Digital Infrastructure, Commercial
> Systems, Power Platform CoE all still open. SIA still lists 10 software/IT
> roles (AOS Application Developer and Lead SWE AI Ops included; eOps Senior SWE
> now visible). STE still lists 125 software roles in SG (Aero 507 Software
> Engineer, UAS Software Engineer, Frontend/Full-stack roles included). SATS not
> re-checked (portal blocks bots — verify manually via MyCareersFuture).

### Changi Airport Group — 13 tech-related openings (posted Aug–Sep 2026)
| Role | Req | Division | Note |
|---|---|---|---|
| **Senior Software Engineer** | 7075 | Airport Management | Primary target — full JD in target-roles.md |
| **Machine Learning Engineer** | 7167 | Airport Management | PyTorch, LangChain, agentic AI, MLOps |
| **Full Stack Developer** | 7133 | Commercial (Changi Digital Factory) | 1–3 yrs; AWS + LLM/RAG stack |
| Asst Manager, Data Engineering & IoT | 1360347866 | Engineering & Development | |
| Manager, Airside Automation Programme | 1365910466 | Airport Management | Domain signal for turnaround-iq |
| Full Stack Developer (2nd req), Commercial Systems, Digital Infrastructure, Power Platform CoE, Robotics ME | — | — | |

### Singapore Airlines — 10 software/IT openings (Aug–Sep 2026)
- Lead Software Engineer (AI Ops and Resilience)
- **Application Developer (AOS)** — AOS = Airport Operations System (domain signal)
- Lead Data Engineer · Senior Data Scientist (Advanced AI Track)
- Lead Engineer, Cloud Platform · Principal Technologist (Application Security Architect)
- Senior Service Designer (Customer Experience) — domain signal for rebook-ai

### ST Engineering — 127 "software" hits in SG; aviation-specific subset (Sep 2026)
- Software Engineer, Full-stack web application development (Aero, West Camp Road)
- Engineer, Software (Aero 507) · Engineer, AI & Digitalisation
- UAS Software Engineer · Principal Engineer, Robotics & Automation · Avionics System Engineer

### Boeing Singapore — 2 openings only (not a priority target).

## 4. Demand Patterns (extracted from real JDs, 2026-09-22)

| Pattern | Evidence | Portfolio implication |
|---|---|---|
| A. CAG's stack is public: **TypeScript, Next.js, Tailwind, MongoDB, REST, Docker, AuthN/AuthZ, AWS** | CAG Req 7075 JD | Portfolio uses the same stack; MongoDB divergence handled by ADR-0002 |
| B. AWS-native with **Lambda, API Gateway, DynamoDB, RDS, S3, Cognito, SNS/SQS, Bedrock, AgentCore, CDK/Terraform, GitHub Actions** | CAG Req 7133 JD | tech-stack.md maps every component to its AWS analog |
| C. **AI/agentic wave**: RAG, guardrails, human-in-the-loop, evaluation, MLOps, drift | CAG Req 7167 + SIA AI roles | mro-copilot implements exactly these concepts |
| D. **Ops-domain knowledge premium**: airport ops (AOS), airside automation, baggage tracking, UAS | CAG careers page, SIA AOS role, STE UAS | turnaround-iq targets this directly |
| E. Seniority signals: problem discovery → prototyping → production ownership, ambiguity tolerance, dual-audience communication | CAG Req 7075 JD | ADRs, traceability matrix, dual-narrative demo script |

## 5. Re-verification Checklist (before applying)

1. Fetch `jobs.changiairport.com/cag/search/?q=software` — confirm Req 7075/7133/7167 still open.
2. Fetch `careers.singaporeair.com/sia/search/?q=software&locationsearch=Singapore`.
3. Fetch `careers.stengg.com/search/?q=software&locationsearch=Singapore`.
4. Check SATS via MyCareersFuture (their site blocks bots).
5. Update this file's snapshot date if > 30 days old.

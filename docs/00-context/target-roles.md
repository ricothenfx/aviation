# Target Roles — Key Job Descriptions & Portfolio Alignment

| Field | Value |
|---|---|
| Status | Active |
| Snapshot date | 2026-09-22 |
| Primary source | market-research.md §3 |

## 1. Primary Target: CAG Senior Software Engineer (Req 7075, Requisition ID 1361363766)

Division: Airport Management · Permanent · Non-shift.

**Role essence:** design, build, and manage full-stack applications supporting digital
transformation of airport operations; from problem discovery and prototyping to production
ownership; autonomy, technical trade-offs, dual-audience communication.

### Technical requirements (verbatim intent)
1. TypeScript — production-quality application code
2. Next.js — full-stack web applications
3. Tailwind CSS — responsive, utility-first UI
4. MongoDB — document-based data model design
5. Git — branching, PRs, collaborative workflows
6. REST APIs — design, consume, integrate, troubleshoot
7. Docker — containerised development/deployment
8. AuthN/AuthZ — users, roles, permissions, protected flows
9. AWS — deploy, operate, integrate

### Also required
- ~5 years experience, CI/CD, automated testing, logging/monitoring, production troubleshooting
- Preferred: IaC, cloud-native practices, mentoring, stakeholder communication

**→ This JD is the 1:1 acceptance target for turnaround-iq (see traceability-matrix.md).**

## 2. Secondary Targets (same employer, CAG)

### Full Stack Developer (Req 7133) — Changi Digital Factory
- Python and/or JS/TS; React/Next.js; REST; relational or NoSQL
- AWS: Lambda, API Gateway, DynamoDB, RDS, S3, Cognito, SNS, SQS, **Bedrock, AgentCore**
- IaC (CDK/Terraform), CI/CD (GitHub Actions)
- GenAI: prompt design, LLM integration, **AI agents, RAG, tool use, evaluation**
- AI-app reliability: grounding, validation, guardrails, observability, human-in-the-loop

### Machine Learning Engineer (Req 7167)
- PyTorch, scikit-learn, LangChain or similar; MLOps: CI/CD, model versioning, experiment tracking, automated retraining, drift handling
- CV + NLP + GenAI/agentic; API/container/orchestration deployment

## 3. Tertiary Targets

| Company | Role | Portfolio hook |
|---|---|---|
| SIA | Application Developer (AOS) | turnaround-iq domain = airport operations systems |
| SIA | Senior Data Scientist (Advanced AI Track) | mro-copilot ML pipeline |
| SIA | Senior Service Designer (CX) | rebook-ai passenger experience |
| ST Engineering | SWE Full-stack web app (Aero) / Engineer AI & Digitalisation | shared stack + AI depth |
| SATS | Tech roles via MyCareersFuture | turnaround-iq ground-ops domain |
| SITA / Amadeus | SWE roles | rebook-ai + event-driven architecture |
| SIAEC / Rolls-Royce / GE / P&W | Digital/AI roles | mro-copilot (NASA C-MAPSS engine health) |

## 4. Alignment Rules

1. Every portfolio feature must trace to a requirement in this file or it does not get built.
2. Where portfolio diverges from a JD (e.g., PostgreSQL vs MongoDB), the divergence must have an ADR and an honest rationale (ADR-0002).
3. Use JD vocabulary in READMEs and demo narration (grounding, guardrails, observability, replan, turnaround) — accuracy over buzzword stuffing.

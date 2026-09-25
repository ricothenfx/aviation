-- Refusal answers carry `source = 'none'` (FR-10/FR-12 honesty): a refused
-- answer has no generation source — neither the LLM nor the extractive
-- fallback produced content. Additive enum widening.
ALTER TYPE "answer_source" ADD VALUE 'none';

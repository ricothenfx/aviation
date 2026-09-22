/**
 * Seeded PRNG (mulberry32) — the only randomness allowed in scenario generation.
 * Same seed ⇒ same reference day ⇒ byte-identical event log (PRD F-5 determinism).
 */
export type Prng = () => number;

export function mulberry32(seed: number): Prng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick an integer in [min, max] using the prng (inclusive bounds). */
export function intBetween(prng: Prng, min: number, max: number): number {
  return min + Math.floor(prng() * (max - min + 1));
}

/** Pick an element using the prng. */
export function pick<T>(prng: Prng, items: readonly T[]): T {
  return items[Math.floor(prng() * items.length)] as T;
}

import { createHash } from "node:crypto";

/**
 * Deterministic UUIDv5 (RFC 4122) so the reference day gets stable primary keys
 * across seed runs, simulators and tests — the precondition for idempotent upserts
 * and byte-identical event logs (ADR-0001, engineering-standards.md §8).
 */

/** Fixed namespace for the turnaround-iq synthetic world (data-ethics.md §2). */
export const TIQ_UUID_NAMESPACE = "1b2a6849-2b11-4f6e-9db1-0f6bd1e4c7a1";

function namespaceBytes(namespace: string): Buffer {
  const hex = namespace.replace(/-/g, "");
  if (hex.length !== 32 || /[^0-9a-f]/.test(hex)) {
    throw new Error("namespace must be a canonical UUID string");
  }
  return Buffer.from(hex, "hex");
}

export function uuidV5(name: string, namespace: string = TIQ_UUID_NAMESPACE): string {
  // RFC 4122 §4.3: UUIDv5 = first 16 bytes of sha1(namespace || name).
  const hash = createHash("sha1").update(namespaceBytes(namespace)).update(name, "utf8").digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

import { hash, verify } from "@node-rs/argon2";

/**
 * Password hashing per D-09 pattern (argon2id), same as the sibling projects'
 * auth modules. @node-rs/argon2 defaults are OWASP-aligned (argon2id,
 * m=19456 KiB, t=2, p=1).
 */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

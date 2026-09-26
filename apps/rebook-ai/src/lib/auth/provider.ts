import type { Role } from "./rbac";

/**
 * Cognito-shaped auth surface (D-09): swapping to Amazon Cognito means
 * implementing this interface against Hosted UI + JWT verification — call
 * sites stay unchanged. Deliberate duplication of the sibling modules:
 * D-08 forbids cross-project imports; the interface shape is kept compatible
 * and interface-tested (rebook-ai architecture.md §5).
 */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface AuthProvider {
  /** Credential sign-in; resolves the user or throws UNAUTHENTICATED. */
  signIn(email: string, password: string): Promise<AuthUser>;
  /** Verify an access token and resolve the current user. */
  verifyToken(token: string): Promise<AuthUser>;
  /** Direct user lookup by id. */
  getUser(userId: string): Promise<AuthUser | null>;
}

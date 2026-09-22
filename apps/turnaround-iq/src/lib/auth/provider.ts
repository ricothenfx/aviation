import type { Role } from "./rbac";

/**
 * Cognito-shaped auth surface (D-09): swapping to Amazon Cognito means implementing
 * this interface against Hosted UI + JWT verification — call sites stay unchanged.
 * Kept intentionally compatible with a Hosted-UI flow: signIn → session, verify → claims.
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

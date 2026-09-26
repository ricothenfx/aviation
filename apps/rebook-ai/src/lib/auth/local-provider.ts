import { eq, sql } from "drizzle-orm";

import { ApiError } from "@aviation/contracts";

import { users } from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";
import { verifySessionToken } from "./jwt";
import { verifyPassword } from "./password";
import type { AuthProvider, AuthUser } from "./provider";
import type { Role } from "./rbac";

function toAuthUser(row: {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  isActive: boolean;
}): AuthUser {
  return { id: row.id, email: row.email, displayName: row.displayName, role: row.role };
}

/**
 * Local dev implementation of AuthProvider (D-09): seeded users + argon2id
 * hashes in PostgreSQL, JWT sessions. Roles: passenger | agent | supervisor
 * (PRD F-7). The Cognito swap target implements the same interface.
 */
export class LocalAuthProvider implements AuthProvider {
  private db() {
    return getSingletonDb();
  }

  async signIn(email: string, password: string): Promise<AuthUser> {
    const normalized = email.trim().toLowerCase();
    const [row] = await this.db()
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${normalized}`)
      .limit(1);

    if (!row || !row.isActive) {
      throw new ApiError("UNAUTHENTICATED", "invalid email or password");
    }
    const ok = await verifyPassword(row.passwordHash, password);
    if (!ok) {
      throw new ApiError("UNAUTHENTICATED", "invalid email or password");
    }
    return toAuthUser(row);
  }

  async verifyToken(token: string): Promise<AuthUser> {
    const claims = await verifySessionToken(token);
    const user = await this.getUser(claims.sub);
    if (!user) {
      throw new ApiError("UNAUTHENTICATED", "session user no longer exists");
    }
    return user;
  }

  async getUser(userId: string): Promise<AuthUser | null> {
    const [row] = await this.db().select().from(users).where(eq(users.id, userId)).limit(1);
    return row ? toAuthUser(row) : null;
  }
}

export function createLocalAuthProvider(): AuthProvider {
  return new LocalAuthProvider();
}

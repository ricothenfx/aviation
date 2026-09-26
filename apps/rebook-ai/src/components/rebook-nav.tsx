"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Primary navigation for the app shell (F1 DoD: app shells for both surfaces).
 * Passenger sees "My trip"; agent/supervisor additionally see the console.
 * Active route is highlighted; logout posts and returns to /login.
 */

const NAV_ITEMS = [
  { href: "/trip", label: "My trip", roles: ["passenger", "agent", "supervisor"] },
  { href: "/console", label: "Agent console", roles: ["agent", "supervisor"] },
] as const;

export function RebookNav({ user }: { user: { email: string; role: string } }) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/v1/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  const items = NAV_ITEMS.filter((item) => (item.roles as readonly string[]).includes(user.role));

  return (
    <header className="border-b border-border bg-surface">
      <div className="flex h-12 items-center gap-4 px-4">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex h-7 w-9 items-center justify-center rounded-md border border-accent/40 bg-raised font-mono text-xs font-bold text-accent">
            RB
          </span>
          <span className="hidden text-sm font-semibold text-fg sm:inline">Rebook.ai</span>
        </Link>

        <nav
          aria-label="Primary"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {items.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors duration-150 ease-out",
                  active ? "bg-raised text-accent" : "text-muted hover:bg-raised/60 hover:text-fg",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden font-mono text-[11px] text-muted md:inline" title={user.email}>
            {user.email}
          </span>
          <span className="rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted">
            {user.role}
          </span>
          <button
            type="button"
            onClick={logout}
            className="rounded-md px-2 py-1 text-xs text-muted transition-colors hover:bg-raised hover:text-fg"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

export function PageContainer({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-6xl px-4 py-6">{children}</div>;
}

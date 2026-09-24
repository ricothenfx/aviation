"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";

import { Button, Input, Label, StatusBadge } from "@aviation/ui";

/**
 * Login (PRD F-7). Seeded demo accounts are printed because this is a portfolio
 * demo environment — accounts are fake from birth (data-ethics.md §5). Roles
 * per mro-copilot PRD: reviewer > engineer > viewer.
 */
const DEMO_ACCOUNTS = [
  { role: "reviewer", email: "wei.lim@mro-sim.example", password: "reviewer-nx-01" },
  { role: "engineer", email: "siti.rahayu@mro-sim.example", password: "engineer-nx-01" },
  { role: "viewer", email: "tom.ng@mro-sim.example", password: "viewer-nx-01" },
] as const;

type Tone = "ok" | "warn" | "danger" | "info" | "muted";

const ROLE_TONES: Record<string, Tone> = {
  reviewer: "warn",
  engineer: "info",
  viewer: "muted",
};

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        // replace(): the home page is dynamic so it always renders fresh
        // server data; refreshing /login here would race the navigation.
        const next = searchParams.get("next");
        router.replace(next && next.startsWith("/") ? next : "/");
        return;
      }
      const body: unknown = await res.json().catch(() => null);
      const message =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: { message?: string } }).error?.message ?? "sign in failed")
          : "sign in failed";
      setError(message);
    } catch {
      setError("network error — is the stack running?");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100dvh-2rem)] items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-12 items-center justify-center rounded-md border border-accent/40 bg-raised font-mono text-sm font-bold text-accent">
            MRO
          </div>
          <div>
            <h1 className="text-lg font-semibold text-fg">MRO Copilot</h1>
            <p className="text-xs text-muted">Maintenance-manual copilot · NX-320 (fictional)</p>
          </div>
        </div>

        <form
          onSubmit={onSubmit}
          className="rounded-lg border border-border bg-surface p-5"
          aria-labelledby="login-heading"
        >
          <h2 id="login-heading" className="text-sm font-medium text-fg">
            Sign in
          </h2>
          <div className="mt-4">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@mro-sim.example"
            />
          </div>
          <div className="mt-3">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          {error ? (
            <p role="alert" className="mt-3 text-xs text-danger">
              {error}
            </p>
          ) : null}

          <Button type="submit" className="mt-4 w-full" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <div className="mt-4 rounded-lg border border-border bg-surface/60 p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">
            Demo accounts (seeded)
          </div>
          <ul className="mt-2 space-y-1.5">
            {DEMO_ACCOUNTS.map((account) => (
              <li key={account.email} className="flex items-center justify-between gap-2 text-xs">
                <StatusBadge tone={ROLE_TONES[account.role]}>{account.role}</StatusBadge>
                <button
                  type="button"
                  className="font-mono text-[11px] text-muted hover:text-accent"
                  onClick={() => {
                    setEmail(account.email);
                    setPassword(account.password);
                  }}
                  title="Fill the form with this demo account"
                >
                  {account.email}
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-4 text-muted">
            Click an account to fill the form. Passwords match{" "}
            <span className="font-mono">seed/users.json</span> (applied by{" "}
            <span className="font-mono">pnpm seed:mro</span>).
          </p>
        </div>
      </div>
    </div>
  );
}

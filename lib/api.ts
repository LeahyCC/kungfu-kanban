import { NextResponse } from 'next/server';
import { AuthError } from '@/lib/auth';

export function errorResponse(e: unknown) {
  if (e instanceof AuthError) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const msg = e instanceof Error ? e.message : 'unknown error';
  return NextResponse.json({ error: redactSecrets(msg) }, { status: 500 });
}

// Defense-in-depth: strip anything that looks like an embedded credential from
// strings that may reach the client or be stored (error messages, task output).
export function redactSecrets(s: string): string {
  if (!s) return s;
  return s
    .replace(/x-access-token:[^@\s]+@/gi, 'x-access-token:***@')
    .replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1***')
    .replace(/(gh[pousr]_[A-Za-z0-9]{4})[A-Za-z0-9]+/g, '$1***')
    .replace(/(AIza[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, '$1***');
}

// Clamp an integer to Postgres int4 range with a sane app-level bound.
export function clampPriority(n: unknown): number {
  const v = Number.isInteger(n) ? (n as number) : 0;
  return Math.max(0, Math.min(3, v));
}

import { NextResponse } from 'next/server';
import { AuthError } from '@/lib/auth';

export function errorResponse(e: unknown) {
  if (e instanceof AuthError) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const msg = e instanceof Error ? e.message : 'unknown error';
  return NextResponse.json({ error: msg }, { status: 500 });
}

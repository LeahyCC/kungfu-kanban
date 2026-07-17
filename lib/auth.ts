// Resolves the current user. With Clerk configured (env vars present) this is
// the real Clerk user; before that, everyone shares a single demo tenant so
// the app is usable immediately after deploy.
export async function getUserId(): Promise<string> {
  if (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    const { auth } = await import('@clerk/nextjs/server');
    const { userId } = await auth();
    if (!userId) throw new AuthError();
    return userId;
  }
  return 'demo-user';
}

export class AuthError extends Error {
  constructor() {
    super('unauthenticated');
  }
}

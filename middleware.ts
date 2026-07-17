import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const hasClerk = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

// Until the Clerk integration is installed on the Vercel project, run open
// (single demo tenant). Once Clerk env vars exist, auth turns on automatically.
export default hasClerk ? clerkMiddleware() : () => NextResponse.next();

export const config = {
  matcher: ['/((?!_next|.*\\..*).*)', '/(api)(.*)'],
};

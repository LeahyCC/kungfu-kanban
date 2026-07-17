import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Kungfu Kanban',
  description: 'A kanban board where every card is an AI agent run — bring your own provider API key.',
};

async function Providers({ children }: { children: React.ReactNode }) {
  if (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    const { ClerkProvider } = await import('@clerk/nextjs');
    return <ClerkProvider>{children}</ClerkProvider>;
  }
  return <>{children}</>;
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <header className="topbar">
            <div className="brand">
              <span className="logo">🥋</span>
              <Link href="/"><h1>Kungfu Kanban</h1></Link>
              <span className="sub">beta · bring your own API key</span>
            </div>
            <nav className="nav">
              <Link href="/board">Board</Link>
              <Link href="/manager">Manager</Link>
              <Link href="/settings">Settings</Link>
            </nav>
          </header>
          {children}
        </Providers>
      </body>
    </html>
  );
}

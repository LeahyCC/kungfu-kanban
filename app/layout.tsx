import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Kungfu Kanban',
  description: 'A kanban board where every card is an AI agent run — bring your own provider API key.',
  manifest: '/site.webmanifest',
  themeColor: '#0f1115',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/icons/favicon-32x32.png', type: 'image/png', sizes: '32x32' },
      { url: '/icons/favicon-16x16.png', type: 'image/png', sizes: '16x16' },
      { url: '/icons/android-icon-192x192.png', type: 'image/png', sizes: '192x192' },
    ],
    apple: [{ url: '/icons/apple-icon-180x180.png', sizes: '180x180' }],
  },
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
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="logo" src="/icons/android-icon-96x96.png" alt="Kungfu Kanban robot" width={28} height={28} />
              <Link href="/"><h1>Kungfu Kanban</h1></Link>
              <span className="sub">beta · bring your own API key</span>
            </div>
            <nav className="nav">
              <Link href="/board">Board</Link>
              <Link href="/manager">Manager</Link>
              <Link href="/billing">Billing</Link>
              <Link href="/settings">Settings</Link>
            </nav>
          </header>
          {children}
        </Providers>
      </body>
    </html>
  );
}

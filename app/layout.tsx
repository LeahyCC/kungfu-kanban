import type { Metadata, Viewport } from 'next';
import { Fraunces, Instrument_Sans, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

const display = Fraunces({
  subsets: ['latin'],
  axes: ['SOFT', 'WONK', 'opsz'],
  variable: '--font-display',
});
const body = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-body',
});
const mono = IBM_Plex_Mono({
  weight: ['400', '500'],
  subsets: ['latin'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'Kungfu Kanban — every card is a fighter',
  description:
    'A kanban board where each card runs an AI agent on your own keys — Claude, GPT, Gemini — and a Manager triages the queue while you review the PRs.',
  manifest: '/site.webmanifest',
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

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F6F2E9' },
    { media: '(prefers-color-scheme: dark)', color: '#141210' },
  ],
};

async function Providers({ children }: { children: React.ReactNode }) {
  if (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    const { ClerkProvider } = await import('@clerk/nextjs');
    return <ClerkProvider>{children}</ClerkProvider>;
  }
  return <>{children}</>;
}

// Applies the saved theme before first paint to avoid a flash.
const themeScript = `try{var t=localStorage.getItem('kk-theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.dataset.theme='dark';}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={`${display.variable} ${body.variable} ${mono.variable}`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import ThemeToggle from './ThemeToggle';

const TABS = [
  { href: '/board', label: 'Board' },
  { href: '/manager', label: 'Manager' },
  { href: '/billing', label: 'Billing' },
  { href: '/settings', label: 'Settings' },
];

// Status cluster: belt-colored dots + counts per column, and the antenna
// light that breathes whenever any card is running.
const BELTS: Array<{ key: string; label: string; cls: string }> = [
  { key: 'backlog', label: 'Backlog', cls: 'belt-todo' },
  { key: 'running', label: 'In Progress', cls: 'belt-doing' },
  { key: 'review', label: 'Review', cls: 'belt-review' },
  { key: 'done', label: 'Done', cls: 'belt-done' },
];

export default function AppHeader() {
  const pathname = usePathname();
  const [counts, setCounts] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/tasks');
        if (!res.ok) return;
        const tasks: Array<{ status: string }> = await res.json();
        if (!alive) return;
        const c: Record<string, number> = { backlog: 0, running: 0, review: 0, done: 0 };
        for (const t of tasks) c[t.status] = (c[t.status] || 0) + 1;
        setCounts(c);
      } catch {}
    };
    load();
    const iv = setInterval(load, 30000);
    return () => { alive = false; clearInterval(iv); };
  }, [pathname]);

  const anyRunning = (counts?.running ?? 0) > 0;

  return (
    <header className="app-header">
      <div className="app-brand">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icons/android-icon-96x96.png" alt="" width={24} height={24} className="app-logo" />
        <Link href="/" className="wordmark">Kungfu Kanban</Link>
        <span
          className={`antenna ${anyRunning ? 'lit' : ''}`}
          role="status"
          aria-label={anyRunning ? `${counts?.running} agent${(counts?.running ?? 0) > 1 ? 's' : ''} running` : 'No agents running'}
        />
      </div>
      <nav className="app-tabs" aria-label="Application">
        {TABS.map((t) => (
          <Link key={t.href} href={t.href} className={`app-tab ${pathname.startsWith(t.href) ? 'active' : ''}`}
            aria-current={pathname.startsWith(t.href) ? 'page' : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="app-status" aria-label="Board summary">
        {counts && BELTS.map((b) => (
          <span key={b.key} className="status-chip" title={`${b.label}: ${counts[b.key] ?? 0}`}>
            <span className={`belt-dot ${b.cls}`} aria-hidden />
            <span className="status-count">{counts[b.key] ?? 0}</span>
          </span>
        ))}
        <ThemeToggle />
      </div>
    </header>
  );
}

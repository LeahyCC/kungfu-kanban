'use client';

import { useEffect, useState } from 'react';

export default function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    setDark(document.documentElement.dataset.theme === 'dark');
  }, []);

  const toggle = () => {
    const next = !(document.documentElement.dataset.theme === 'dark');
    if (next) document.documentElement.dataset.theme = 'dark';
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('kk-theme', next ? 'dark' : 'light'); } catch {}
    setDark(next);
  };

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={dark ? 'Day dojo' : 'Night dojo'}
    >
      {dark === null ? '◐' : dark ? '☀' : '☾'}
    </button>
  );
}

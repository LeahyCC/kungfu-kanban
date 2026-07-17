'use client';

import { useEffect, useState } from 'react';

// Night dojo (dark) is the default; light is the stored override.
export default function ThemeToggle() {
  const [light, setLight] = useState<boolean | null>(null);

  useEffect(() => {
    setLight(document.documentElement.dataset.theme === 'light');
  }, []);

  const toggle = () => {
    const next = !(document.documentElement.dataset.theme === 'light');
    if (next) document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('kk-theme', next ? 'light' : 'dark'); } catch {}
    setLight(next);
  };

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={light ? 'Switch to dark theme' : 'Switch to light theme'}
      title={light ? 'Night dojo' : 'Day dojo'}
    >
      {light === null ? '◐' : light ? '☾' : '☀'}
    </button>
  );
}

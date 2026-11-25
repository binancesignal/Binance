'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'app_theme';
const ThemeCtx = createContext({ theme: 'light', setTheme: () => {}, toggle: () => {} });

function applyDomTheme(theme) {
  if (typeof document === 'undefined') return;
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  try {
    document.documentElement.style.colorScheme = t;
  } catch (_) {}
}

/** Read stored theme before paint to avoid flash — also injectable via inline script in layout. */
export function getStoredTheme() {
  if (typeof window === 'undefined') return 'light';
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'dark' || v === 'light') return v;
  } catch (_) {}
  return 'light';
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState('light');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const t = getStoredTheme();
    setThemeState(t);
    applyDomTheme(t);
    setReady(true);
  }, []);

  const setTheme = useCallback((next) => {
    const t = next === 'dark' ? 'dark' : 'light';
    setThemeState(t);
    applyDomTheme(t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch (_) {}
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  const value = useMemo(() => ({ theme, setTheme, toggle, ready }), [theme, setTheme, toggle, ready]);

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  return useContext(ThemeCtx);
}

/** Compact control for Settings / topbar */
export function ThemePicker() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="theme-picker" role="group" aria-label="Theme">
      <button
        type="button"
        className={`theme-option${theme === 'light' ? ' on' : ''}`}
        onClick={() => setTheme('light')}
      >
        <div className="theme-swatch light" aria-hidden="true">
          <span /><span /><span />
        </div>
        Light
      </button>
      <button
        type="button"
        className={`theme-option${theme === 'dark' ? ' on' : ''}`}
        onClick={() => setTheme('dark')}
      >
        <div className="theme-swatch dark" aria-hidden="true">
          <span /><span /><span />
        </div>
        Black
      </button>
    </div>
  );
}

import './globals.css';
import { ThemeProvider } from '../components/ThemeProvider.js';

export const metadata = {
  title: 'Signal Desk — Live Board & Auto-Trade',
  description: 'Multi-user signal board with Bybit auto-trade. Free 7-day trial.',
};

/** Runs before paint so dark mode doesn't flash white. */
const themeBootScript = `
(function(){
  try {
    var t = localStorage.getItem('app_theme');
    if (t !== 'dark' && t !== 'light') t = 'light';
    document.documentElement.setAttribute('data-theme', t);
    document.documentElement.style.colorScheme = t;
  } catch (e) {}
})();
`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#0B1220" media="(prefers-color-scheme: dark)" />
        <meta name="theme-color" content="#F4F5F7" media="(prefers-color-scheme: light)" />
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body style={{ margin: 0 }}>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}

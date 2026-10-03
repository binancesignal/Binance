export const metadata = {
  title: 'Signal Desk — Live Board & Auto-Trade',
  description: 'Multi-user signal board with Bybit auto-trade. Free 7-day trial.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#F4F5F7" />
      </head>
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}

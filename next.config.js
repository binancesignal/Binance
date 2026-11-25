/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Native module used to render the Telegram chart PNG — must not be bundled.
  serverExternalPackages: ['@resvg/resvg-js'],
  env: {
    NEXT_PUBLIC_APP_VERSION: '2.0.9',
    NEXT_PUBLIC_GIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA || '',
  },
  async rewrites() {
    return [
      {
        source: '/trading-monitor-api/:path*',
        destination: '/api/:path*',
      },
    ];
  },
};

module.exports = nextConfig;

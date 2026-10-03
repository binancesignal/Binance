/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Native module used to render the Telegram chart PNG — must not be bundled.
  serverExternalPackages: ['@resvg/resvg-js'],
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

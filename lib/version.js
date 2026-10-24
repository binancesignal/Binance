// App version label shown in Profile and Admin.
export const APP_VERSION = '2.1.0';
export const APP_BUILD = 'binance-13';

export function getVersionLabel() {
  return `v${APP_VERSION} (${APP_BUILD})`;
}

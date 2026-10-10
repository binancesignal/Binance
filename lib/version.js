/** App version — bump when shipping user-visible changes so deploys are verifiable. */
export const APP_VERSION = '2.0.9';

/** Short git/deploy id when running on Vercel (empty in local/dev). */
export function getDeployId() {
  if (typeof process === 'undefined') return '';
  const sha =
    process.env.NEXT_PUBLIC_GIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
    '';
  return sha ? String(sha).slice(0, 7) : '';
}

export function getVersionLabel() {
  const ver = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_APP_VERSION) || APP_VERSION;
  const id = getDeployId();
  return id ? `v${ver} · ${id}` : `v${ver}`;
}

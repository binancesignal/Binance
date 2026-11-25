// Thin indirection over app_state so the runner can be unit-tested without a database.
let impl = null;
export function setStateImpl(i) {
  impl = i;
}
export async function S() {
  if (!impl) impl = await import('../database/appState.js');
  return impl;
}

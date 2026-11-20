// Reads public/config.json → { "appsScriptUrl": "https://script.google.com/macros/s/…/exec" }.
// Another organisation can use the same app with its own Google Sheet: its links carry ?org=<deployment id>.
import type { Backend } from './types';
import { gasBackend, initGas, ORG_ID } from './backend.gas';

export const backend: Backend = gasBackend;

function pickOrg(): string {
  let id = '';
  try {
    id = new URLSearchParams(location.search).get('org') ?? '';
    if (ORG_ID.test(id)) localStorage.setItem('punchin.org', id);
    else id = localStorage.getItem('punchin.org') ?? '';
  } catch { /* private mode */ }
  return ORG_ID.test(id) ? id : '';
}

export async function initBackend(): Promise<boolean> {
  const org = pickOrg();
  if (org) { initGas(`https://script.google.com/macros/s/${org}/exec`, org); return true; }
  try {
    const cfg = await (await fetch('./config.json', { cache: 'no-store' })).json();
    if (typeof cfg.appsScriptUrl === 'string' && /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(cfg.appsScriptUrl)) initGas(cfg.appsScriptUrl);
  } catch { /* stays unconfigured */ }
  return backend.configured;
}

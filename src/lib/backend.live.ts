// Reads public/config.json → { "appsScriptUrl": "https://script.google.com/macros/s/…/exec" }
import type { Backend } from './types';
import { gasBackend, initGas } from './backend.gas';

export const backend: Backend = gasBackend;

export async function initBackend(): Promise<boolean> {
  try {
    const cfg = await (await fetch('./config.json', { cache: 'no-store' })).json();
    if (typeof cfg.appsScriptUrl === 'string' && /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(cfg.appsScriptUrl)) initGas(cfg.appsScriptUrl);
  } catch { /* stays unconfigured */ }
  return backend.configured;
}

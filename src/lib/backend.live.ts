// Picks the database from public/config.json:
//   { "appsScriptUrl": "https://script.google.com/macros/s/…/exec" }   → Google Sheets (free)
//   { "supabaseUrl": "…", "supabaseAnonKey": "…" }                      → Supabase
import type { Backend } from './types';
import { gasBackend, initGas } from './backend.gas';
import { supabaseBackend, initSupabase } from './backend.supabase';

export let backend: Backend = gasBackend;

export async function initBackend(): Promise<boolean> {
  try {
    const cfg = await (await fetch('./config.json', { cache: 'no-store' })).json();
    if (cfg.appsScriptUrl) { initGas(cfg.appsScriptUrl); backend = gasBackend; }
    else if (cfg.supabaseUrl && cfg.supabaseAnonKey) { initSupabase(cfg.supabaseUrl, cfg.supabaseAnonKey); backend = supabaseBackend; }
  } catch { /* stays unconfigured */ }
  return backend.configured;
}

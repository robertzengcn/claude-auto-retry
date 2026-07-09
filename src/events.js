// StopFailure event channel: the authoritative, scrape-free overload trigger.
//
// Claude Code's `StopFailure` hook fires only when a turn ends in an API error, with a
// typed `error` (matcher-filtered to overloaded/server_error). The hook runs
// as a CHILD of claude, so it inherits the env the launcher stamped onto claude —
// including CLAUDE_AUTO_RETRY_PANE. It writes a marker keyed by that pane; the daemon,
// which already knows its pane, reads it directly. No session-id plumbing needed (the
// main claude PID's environ does not even carry CLAUDE_CODE_SESSION_ID).
//
// Markers are short-lived (consumed on action, ignored past eventMaxAge) so a recycled
// tmux pane id can't replay a stale failure.

import { mkdir, writeFile, readFile, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sanitizeKey } from './pane-key.js';

export const EVENTS_DIR = join(homedir(), '.claude-auto-retry', 'events');

// Error types the event path treats as a *transient overload* (seconds-scale backoff).
// `rate_limit` is NOT here: for a subscription/gateway usage limit it is an HOURS-scale
// wait until a printed reset time, not a seconds-scale retry. Routing it through the
// overload path fired futile "Continue" retries into a session-limited pane. It has its
// own classification (USAGE_LIMIT) and the monitor routes it to the usage-wait path,
// scraping the reset timestamp from the pane (the StopFailure payload carries none).
const RETRYABLE = new Set(['overloaded', 'server_error']);
// Claude Code reports `rate_limit` when a usage/session limit ends the turn. Reliable on
// gateways (z.ai & similar) where the 429 renders transiently and the tail-restricted
// scraper misses it — the event is the trustworthy trigger for those sessions.
const USAGE_LIMIT = new Set(['rate_limit']);

export function isRetryableError(errorType) {
  return typeof errorType === 'string' && RETRYABLE.has(errorType.toLowerCase());
}

export function isUsageLimitError(errorType) {
  return typeof errorType === 'string' && USAGE_LIMIT.has(errorType.toLowerCase());
}

// Any error the hook should persist as an event for the monitor to act on:
// overloaded/server_error → seconds-scale overload backoff; rate_limit → hours-scale
// usage wait. Permanent errors (auth/billing/invalid) never persist — no retry helps.
export function isActionableError(errorType) {
  return isRetryableError(errorType) || isUsageLimitError(errorType);
}

// tmux pane ids look like "%2"; keep the marker filename to a safe charset.
function fileFor(paneKey, dir) {
  return join(dir, `${sanitizeKey(paneKey)}.json`);
}

// Hook side: write a marker for the pane. Atomic (tmp + rename) so the daemon never
// reads a half-written file.
export async function writeStopFailureEvent(paneKey, payload, dir = EVENTS_DIR) {
  if (!paneKey) return null;
  const error = typeof payload?.error === 'string' ? payload.error : 'unknown';
  await mkdir(dir, { recursive: true });
  const file = fileFor(paneKey, dir);
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify({ pane: String(paneKey), error, session_id: payload?.session_id ?? null, ts: Date.now() });
  await writeFile(tmp, body);
  await rename(tmp, file);
  return file;
}

// Daemon side: return a fresh marker for the pane, or null (absent / unparseable / stale).
export async function readStopFailureEvent(paneKey, maxAgeMs, dir = EVENTS_DIR) {
  if (!paneKey) return null;
  try {
    const ev = JSON.parse(await readFile(fileFor(paneKey, dir), 'utf-8'));
    if (typeof ev.ts !== 'number' || Date.now() - ev.ts > maxAgeMs) return null;
    return ev;
  } catch { return null; }
}

export async function clearStopFailureEvent(paneKey, dir = EVENTS_DIR) {
  try { await unlink(fileFor(paneKey, dir)); } catch { /* already gone */ }
}

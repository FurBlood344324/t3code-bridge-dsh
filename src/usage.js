// Token totals from dsh's own call counter (`<DSH_HOME>/bot/usage.sqlite`, table `calls`).
//
// T3 shows no usage for dsh runs and its offline scanner does not read dsh sessions, so this is
// the on-demand view. The counter has no profile column (sessions are not tagged with the profile
// that ran them), so the report groups by provider/model/kind or by day, not by profile.
// Read-only: the database is opened with `readOnly` and never written.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const USAGE_DB = ['bot', 'usage.sqlite'];

/** `YYYY-MM-DD` (local midnight) -> epoch ms; throws on anything else. */
export function parseSince(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error('--since must be a date like 2026-11-01');
  }
  const ms = new Date(`${text}T00:00:00`).getTime();
  if (Number.isNaN(ms)) throw new Error('--since is not a valid date');
  return ms;
}

/**
 * Totals per group. `by` is "model" (provider, model, kind) or "day" (local date).
 * Returns `{ path, rows: [{ group, calls, input, cacheRead, output }], total }`.
 */
export async function readUsage({ home, since, by = 'model' }) {
  const path = join(home, ...USAGE_DB);
  if (!existsSync(path)) throw new Error(`no dsh usage counter at ${path}`);
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    throw new Error('usage needs Node >= 22.5 (node:sqlite)');
  }
  if (by !== 'model' && by !== 'day') throw new Error('--by must be "model" or "day"');

  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const expr =
      by === 'day'
        ? "strftime('%Y-%m-%d', time / 1000, 'unixepoch', 'localtime')"
        : "provider || ' / ' || model || ' / ' || kind";
    const where = since === undefined ? '' : 'WHERE time >= ?';
    const sql =
      `SELECT ${expr} AS grp, COUNT(*) AS calls, SUM(input) AS input, SUM(cache_read) AS cacheRead, ` +
      `SUM(output) AS output FROM calls ${where} GROUP BY grp ORDER BY ${by === 'day' ? 'grp' : 'calls DESC'}`;
    const stmt = db.prepare(sql);
    const raw = since === undefined ? stmt.all() : stmt.all(since);
    const rows = raw.map((r) => ({
      group: String(r.grp),
      calls: Number(r.calls),
      input: Number(r.input ?? 0),
      cacheRead: Number(r.cacheRead ?? 0),
      output: Number(r.output ?? 0),
    }));
    const total = rows.reduce(
      (acc, r) => ({
        calls: acc.calls + r.calls,
        input: acc.input + r.input,
        cacheRead: acc.cacheRead + r.cacheRead,
        output: acc.output + r.output,
      }),
      { calls: 0, input: 0, cacheRead: 0, output: 0 },
    );
    return { path, rows, total };
  } finally {
    db.close();
  }
}

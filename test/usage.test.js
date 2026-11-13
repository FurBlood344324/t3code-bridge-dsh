import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main } from '../src/cli.js';
import { parseSince, readUsage } from '../src/usage.js';

const hasSqlite = await import('node:sqlite').then(() => true, () => false);

async function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-usage-'));
  fs.mkdirSync(path.join(home, 'bot'));
  if (!hasSqlite) return home;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(home, 'bot', 'usage.sqlite'));
  db.exec(`CREATE TABLE calls (key TEXT PRIMARY KEY, session TEXT NOT NULL, time INTEGER NOT NULL, provider TEXT NOT NULL,
    model TEXT NOT NULL, kind TEXT NOT NULL, live INTEGER NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL,
    cache_write INTEGER NOT NULL, output INTEGER NOT NULL)`);
  const ins = db.prepare('INSERT INTO calls VALUES (?,?,?,?,?,?,0,?,?,0,?)');
  ins.run('a', 's1', new Date('2026-11-10T12:00:00').getTime(), 'opendesign', 'flash', 'turn', 10, 100, 5);
  ins.run('b', 's1', new Date('2026-11-10T13:00:00').getTime(), 'opendesign', 'flash', 'turn', 20, 0, 7);
  ins.run('c', 's2', new Date('2026-11-12T12:00:00').getTime(), 'command-code', 'ds', 'memory', 1, 2, 3);
  db.close();
  return home;
}

test('parseSince accepts a date and rejects junk', () => {
  assert.ok(parseSince('2026-11-01') > 0);
  assert.throws(() => parseSince('yesterday'), /--since/);
});

test('readUsage totals by model and by day, honouring --since', { skip: !hasSqlite }, async () => {
  const home = await fakeHome();
  const byModel = await readUsage({ home });
  assert.equal(byModel.total.calls, 3);
  assert.equal(byModel.total.input, 31);
  assert.equal(byModel.rows[0].group, 'opendesign / flash / turn');
  assert.equal(byModel.rows[0].output, 12);
  const byDay = await readUsage({ home, by: 'day' });
  assert.deepEqual(byDay.rows.map((r) => r.group), ['2026-11-10', '2026-11-12']);
  const since = await readUsage({ home, since: parseSince('2026-11-11') });
  assert.equal(since.total.calls, 1);
});

test('readUsage: missing counter is a clear error; the db is never modified', { skip: !hasSqlite }, async () => {
  await assert.rejects(() => readUsage({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-nousage-')) }), /no dsh usage counter/);
  const home = await fakeHome();
  const before = fs.readFileSync(path.join(home, 'bot', 'usage.sqlite'));
  await readUsage({ home });
  assert.ok(before.equals(fs.readFileSync(path.join(home, 'bot', 'usage.sqlite'))));
});

test('cli usage prints a table, --json parses, bad flags exit 2/1', { skip: !hasSqlite }, async () => {
  const home = await fakeHome();
  const env = { ...process.env, DSH_HOME: home };
  const run = async (argv) => {
    let o = '';
    let e = '';
    const code = await main(argv, { stdout: { write: (t) => (o += t) }, stderr: { write: (t) => (e += t) }, env });
    return { code, o, e };
  };
  const table = await run(['usage']);
  assert.equal(table.code, 0);
  assert.match(table.o, /TOTAL\s+3\s+31/);
  const json = await run(['usage', '--json', '--by', 'day']);
  assert.equal(JSON.parse(json.o).rows.length, 2);
  assert.equal((await run(['usage', '--since', 'x'])).code, 1);
  assert.equal((await run(['usage', '--bogus'])).code, 2);
  assert.equal((await run(['profiles', '--json'])).code, 2);
});

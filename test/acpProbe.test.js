import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { probeAcp } from '../src/acpProbe.js';

function tempDir(prefix = 'acp-probe-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Writes a tiny fake ACP agent and returns its script path. */
function writeFake(dir, name, source) {
  const file = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(file, source);
  return file;
}

/** Answers initialize + session/list the way dsh does. */
const GOOD_AGENT = `
import fs from 'node:fs';
const log = process.argv[2];
const pidFile = process.argv[3];
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    if (log) fs.appendFileSync(log, line + '\\n');
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params.protocolVersion,
          agentInfo: { name: 'deepseek-harness-acp', version: '0.2.2-rc.1' },
          agentCapabilities: { sessionCapabilities: { close: {}, list: {}, resume: {} } },
        },
      }) + '\\n');
    } else if (msg.method === 'session/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { sessions: [{ sessionId: 's1', cwd: msg.params.cwd }, { sessionId: 's2', cwd: msg.params.cwd }] },
      }) + '\\n');
    }
  }
});
`;

test('probeAcp: the happy path returns agent info, capabilities and the session count', async () => {
  const dir = tempDir();
  const log = path.join(dir, 'requests.log');
  const pidFile = path.join(dir, 'pid');
  const script = writeFake(dir, 'good-agent', GOOD_AGENT);
  const cwd = tempDir('acp-probe-cwd-');
  const cwdBefore = fs.readdirSync(cwd);

  const result = await probeAcp({ command: process.execPath, args: [script, log, pidFile], cwd, timeoutMs: 15000 });

  assert.equal(result.ok, true, `unexpected error: ${result.error}`);
  assert.equal(typeof result.ms, 'number');
  assert.ok(result.ms >= 0);
  assert.deepEqual(result.agentInfo, { name: 'deepseek-harness-acp', version: '0.2.2-rc.1' });
  assert.equal(result.protocolVersion, 1);
  assert.deepEqual(result.sessionCapabilities, { close: {}, list: {}, resume: {} });
  assert.equal(result.sessionCount, 2);
  assert.equal(result.error, undefined);

  // what we sent: initialize with protocolVersion 1 and our clientInfo, then session/list with the cwd
  const requests = fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, 'initialize');
  assert.equal(requests[0].params.protocolVersion, 1);
  assert.equal(requests[0].params.clientInfo.name, 't3code-bridge-dsh');
  assert.equal(typeof requests[0].params.clientInfo.version, 'string');
  assert.equal(requests[1].method, 'session/list');
  assert.deepEqual(requests[1].params, { cwd });

  // the probe never writes to the child's cwd
  assert.deepEqual(fs.readdirSync(cwd), cwdBefore);

  // and never leaves the child behind
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(isAlive(pid), false, `child ${pid} still running`);
});

test('probeAcp: an agent that answers with an error is reported as ok:false', async () => {
  const dir = tempDir();
  const script = writeFake(
    dir,
    'angry-agent',
    `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' },
    }) + '\\n');
  }
});
`,
  );

  const result = await probeAcp({ command: process.execPath, args: [script], timeoutMs: 15000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /initialize failed: Method not found \(-32601\)/);
});

test('probeAcp: a silent agent times out and its process is killed', async () => {
  const dir = tempDir();
  const pidFile = path.join(dir, 'pid');
  const script = writeFake(
    dir,
    'silent-agent',
    `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdin.resume();
setInterval(() => {}, 1000);
`,
  );

  const started = Date.now();
  const result = await probeAcp({ command: process.execPath, args: [script], timeoutMs: 300 });

  assert.equal(result.ok, false);
  assert.match(result.error, /no ACP answer within 300ms/);
  assert.ok(Date.now() - started >= 250, 'waited for the deadline');
  assert.ok(Date.now() - started < 8000, 'did not hang past the grace period');

  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(await isDead(pid), true, `child ${pid} survived the timeout`);
});

test('probeAcp: an agent that exits early is reported, with its stderr', async () => {
  const dir = tempDir();
  const script = writeFake(
    dir,
    'crashing-agent',
    `
process.stderr.write('no model route configured\\n');
process.exit(3);
`,
  );

  const result = await probeAcp({ command: process.execPath, args: [script], timeoutMs: 15000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /exited before answering \(code 3\)/);
  assert.match(result.error, /no model route configured/);
});

test('probeAcp: a missing command resolves ok:false instead of throwing', async () => {
  const dir = tempDir();
  const result = await probeAcp({
    command: path.join(dir, 'definitely-not-installed-dsh'),
    args: ['--profile', 'acp'],
    timeoutMs: 5000,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot start/);
  assert.match(result.error, /not found/);
  assert.equal(typeof result.ms, 'number');
});

test('probeAcp: a missing command name is rejected without spawning', async () => {
  const result = await probeAcp({ command: '', timeoutMs: 1000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /command is required/);
});

test('probeAcp: a non-JSON noise line before the answer is ignored', async () => {
  const dir = tempDir();
  const script = writeFake(
    dir,
    'noisy-agent',
    `
let buffer = '';
process.stdout.write('booting dsh acp app...\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { protocolVersion: 1, agentInfo: { name: 'noisy' }, agentCapabilities: { sessionCapabilities: { list: {} } } },
      }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessions: [] } }) + '\\n');
    }
  }
});
`,
  );

  const result = await probeAcp({ command: process.execPath, args: [script], timeoutMs: 15000 });
  assert.equal(result.ok, true, `unexpected error: ${result.error}`);
  assert.deepEqual(result.agentInfo, { name: 'noisy' });
  assert.equal(result.sessionCount, 0);
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function isDead(pid) {
  for (let i = 0; i < 40; i += 1) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

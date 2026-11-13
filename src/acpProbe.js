// ACP probe: does this command speak Agent Client Protocol (initialize + session/list)?
//
// One short-lived child process per call. The probe never rejects: a closed
// stdin, a crash, a missing binary or a silent agent all come back as
// `{ ok: false, error }` so `doctor` can report every profile.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLIENT_NAME = 't3code-bridge-dsh';
const PROTOCOL_VERSION = 1;
const KILL_GRACE_MS = 500;

/**
 * Probe one ACP command.
 * @returns {Promise<{ok:boolean, agentInfo?:object, protocolVersion?:number,
 *   sessionCapabilities?:object, sessionCount?:number, error?:string, ms:number}>}
 */
export async function probeAcp({
  command,
  args = [],
  env = process.env,
  cwd = process.cwd(),
  timeoutMs = 20000,
  killGraceMs = KILL_GRACE_MS,
} = {}) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  if (typeof command !== 'string' || command.trim() === '') {
    return { ok: false, error: 'probeAcp: command is required', ms: elapsed() };
  }

  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // own process group on POSIX so a timeout can take the agent's children
      // (dsh spawns its mcp bridge) down with it, not only the direct child
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    return { ok: false, error: `cannot start ${command}: ${err && err.message}`, ms: elapsed() };
  }

  return new Promise((resolve) => {
    let settled = false;
    let stderrTail = '';
    let deadlineTimer = null;
    // what the agent has told us so far; a later failure still reports it
    const state = { initialize: {} };

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      try {
        child.stdin?.end();
      } catch {
        /* the agent may have closed it already */
      }
      await killChild(child, killGraceMs);
      resolve(compact({ ...result, ms: elapsed() }));
    };

    const fail = (message, extra = {}) => finish({ ok: false, error: message, ...extra });

    deadlineTimer = setTimeout(() => {
      const detail = stderrTail.trim() ? `; stderr: ${truncate(stderrTail.trim(), 400)}` : '';
      // keep whatever the agent already told us: doctor can still show it
      fail(`no ACP answer within ${timeoutMs}ms${detail}`, state.initialize);
    }, Math.min(Math.max(1, timeoutMs), 2 ** 31 - 1));

    child.on('error', (err) => {
      const hint = err && err.code === 'ENOENT' ? ` (not found: ${command})` : '';
      fail(`cannot start ${command}${hint}: ${err && err.message}`);
    });

    child.on('exit', (code, signal) => {
      const how = signal ? `signal ${signal}` : `code ${code}`;
      const detail = stderrTail.trim() ? `; stderr: ${truncate(stderrTail.trim(), 400)}` : '';
      fail(`ACP agent exited before answering (${how})${detail}`, state.initialize);
    });

    child.stdin?.on('error', () => {
      /* EPIPE when the agent dies: the exit handler reports it */
    });

    let buffered = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      buffered += chunk;
      let index;
      while ((index = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, index).trim();
        buffered = buffered.slice(index + 1);
        if (line === '') continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // not JSON-RPC: ignore (some agents log to stdout)
        }
        onMessage(message);
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    function send(message) {
      if (settled) return;
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (err) {
        fail(`cannot write to the ACP agent: ${err && err.message}`);
      }
    }

    function onMessage(message) {
      if (!message || typeof message !== 'object') return;
      if (message.id === 1 && !message.method) {
        if (message.error) {
          fail(`initialize failed: ${describeError(message.error)}`);
          return;
        }
        const result = message.result ?? {};
        const capabilities = result.agentCapabilities ?? {};
        const sessionCapabilities = capabilities.sessionCapabilities ?? result.sessionCapabilities;
        state.initialize = {
          agentInfo: result.agentInfo,
          protocolVersion: result.protocolVersion,
          sessionCapabilities,
        };
        send({ jsonrpc: '2.0', id: 2, method: 'session/list', params: { cwd } });
        return;
      }
      if (message.id === 2 && !message.method) {
        if (message.error) {
          fail(`session/list failed: ${describeError(message.error)}`, state.initialize);
          return;
        }
        const result = message.result ?? {};
        const sessions = Array.isArray(result) ? result : result.sessions;
        const sessionCount = Array.isArray(sessions) ? sessions.length : 0;
        finish({ ok: true, ...state.initialize, sessionCount });
      }
    }

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: CLIENT_NAME, version: packageVersion() },
      },
    });
  });
}

/** Best-effort version of this package, for the ACP `clientInfo`. */
export function packageVersion() {
  try {
    const path = fileURLToPath(new URL('../package.json', import.meta.url));
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function describeError(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  const code = error.code !== undefined ? ` (${error.code})` : '';
  return `${error.message || 'unknown error'}${code}`;
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Drops `undefined` members so the result prints as clean JSON. */
function compact(value) {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out;
}

/** SIGTERM, then SIGKILL after the grace period. Resolves when the child is gone. */
function killChild(child, graceMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let hard = null;
    let bail = null;
    // a child that never started (ENOENT) can still emit an 'error' on kill;
    // without a listener that would escape as an uncaught exception.
    child.on('error', () => {});
    const done = () => {
      clearTimeout(hard);
      clearTimeout(bail);
      resolve();
    };
    child.once('exit', done);
    signalChild(child, 'SIGTERM');
    hard = setTimeout(() => signalChild(child, 'SIGKILL'), graceMs);
    // never hang the caller on a wedged child: report the timeout instead
    bail = setTimeout(done, graceMs * 4);
  });
}

/** Signal the child and, when it leads its own group, the whole group. */
function signalChild(child, signal) {
  if (typeof child.pid === 'number' && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal); // negative pid = process group
      return;
    } catch {
      /* group gone or not a group leader: fall through to the direct child */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}

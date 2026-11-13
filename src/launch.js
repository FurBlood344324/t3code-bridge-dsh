// Launcher: T3 spawns this instead of `dsh`, we resolve the API keys and exec dsh on top.
//
// T3 instance config is `commandPath: <node>, commandArgs: ["launch", "<profile>"]`. `launch`
// resolves the keys (src/secrets.js), makes sure the routes overlay exists (src/routes.js),
// then runs `dsh --profile <profile>-acp --patch <overlay>` with inherited stdio so ACP bytes
// pass through untouched. Keys travel only as environment variables of that child.
//
// `buildLaunch` is pure: it spawns nothing, so the CLI can print the masked report first.

import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { overlayPath, writeOverlay } from './routes.js';
import { defaultDshHome, resolveKeys } from './secrets.js';

/** Profile names accepted by the launcher (`web`, `dsbot`, `open-design`, `dsh-tui`, ...). */
const PROFILE_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Signals forwarded to the child. */
export const FORWARDED_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT', 'SIGHUP']);

/** Shell-style exit code for a child killed by a signal. */
const SIGNAL_NUMBERS = Object.freeze({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 });

/** `<profile>-acp`, or a clear error for a name dsh would accept and we should not. */
export function acpProfileName(profile) {
  if (typeof profile !== 'string' || profile.trim() === '') {
    throw new Error('a dsh profile name is required (for example `web`)');
  }
  if (!PROFILE_RE.test(profile)) {
    // The name is deliberately not echoed: a pasted API key would otherwise land in a T3 log.
    throw new Error(
      `invalid dsh profile name (${profile.length} chars): expected [a-z0-9][a-z0-9._-]* (lowercase letters, digits, dot, dash, underscore)`,
    );
  }
  return `${profile}-acp`;
}

function isExecutableFile(path) {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `dsh` from PATH (or an absolute path when `dshPath` is given).
 * @returns {string} the command to spawn
 */
export function findDsh(env = process.env, { dshPath } = {}) {
  if (typeof dshPath === 'string' && dshPath.trim() !== '') return dshPath;
  const rawPath = env && typeof env.PATH === 'string' ? env.PATH : '';
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of rawPath.split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      const candidate = join(dir, `dsh${ext}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  throw new Error('dsh was not found on PATH; install DeepSeek Harness or pass its absolute path');
}

/**
 * Build the child process description for one profile. Nothing is started.
 * @param {{profile: string, dshPath?: string, env?: object, dshHome?: string, overlay?: string,
 *   piAuthPath?: string, opencodeAuthPath?: string}} options
 * @returns {{command: string, args: string[], env: Record<string,string>, profile: string,
 *   overlay: string, report: Array<object>}}
 */
export function buildLaunch({
  profile,
  dshPath,
  env = process.env,
  dshHome,
  overlay,
  piAuthPath,
  opencodeAuthPath,
} = {}) {
  const variant = acpProfileName(profile);
  const baseEnv = env && typeof env === 'object' ? env : {};
  const command = findDsh(baseEnv, { dshPath });
  // An explicit dshHome overrides the parent environment's DSH_HOME (that is what the caller asked for).
  const home = defaultDshHome(dshHome ? { ...baseEnv, DSH_HOME: dshHome } : baseEnv);
  const overlayFile = overlay ? overlay : overlayPath(baseEnv);

  const { env: keys, report } = resolveKeys({ env: baseEnv, dshHome: home, piAuthPath, opencodeAuthPath });

  // Keys are merged last: a provider must run on the key we resolved, not on a stale one the
  // parent happened to carry. Everything else in the parent environment reaches dsh unchanged.
  const childEnv = { ...baseEnv, ...keys, DSH_HOME: home };

  return {
    command,
    args: ['--profile', variant, '--patch', overlayFile],
    env: childEnv,
    profile: variant,
    overlay: overlayFile,
    report,
  };
}

function exitCodeFor(code, signal) {
  if (typeof code === 'number') return code;
  if (signal && SIGNAL_NUMBERS[signal] !== undefined) return 128 + SIGNAL_NUMBERS[signal];
  return 1;
}

/**
 * Spawn dsh for one profile and pass ACP traffic through.
 * The overlay is (re)written when its content changed, so a template update reaches the next run.
 * @returns {Promise<number>} the child's exit code (128 + signal number when it was killed)
 */
export async function launch({
  profile,
  dshPath,
  env = process.env,
  dshHome,
  overlay,
  piAuthPath,
  opencodeAuthPath,
  routes,
  dryRun = false,
  stdio = 'inherit',
  onSpawn,
} = {}) {
  const plan = buildLaunch({ profile, dshPath, env, dshHome, overlay, piAuthPath, opencodeAuthPath });
  if (dryRun) return 0;

  writeOverlay(plan.overlay, { routes });

  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(plan.command, plan.args, {
        env: plan.env,
        stdio,
        windowsHide: true,
      });
    } catch (err) {
      reject(new Error(`cannot start ${plan.command}: ${err && err.message}`));
      return;
    }

    const handlers = new Map();
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      handlers.clear();
    };

    for (const signal of FORWARDED_SIGNALS) {
      const handler = () => {
        // A second signal is the operator insisting: do not swallow it.
        if (child.exitCode !== null || child.signalCode !== null) {
          cleanup();
          process.kill(process.pid, signal);
          return;
        }
        child.kill(signal);
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }

    if (typeof onSpawn === 'function') {
      try {
        onSpawn(child);
      } catch {
        // an observer must not break the launcher
      }
    }

    child.once('error', (err) => {
      cleanup();
      reject(new Error(`cannot start ${plan.command}: ${err && err.message}`));
    });
    child.once('close', (code, signal) => {
      cleanup();
      resolvePromise(exitCodeFor(code, signal));
    });
  });
}

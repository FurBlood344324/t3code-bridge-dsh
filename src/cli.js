// CLI: the operator commands, and `launch`, which T3 spawns once per provider instance.
//
// Two audiences on one entry point:
//   - the operator runs profiles / routes / install / uninstall / sync / doctor;
//   - T3 runs `launch <profile>` as the provider command: that resolves the API keys
//     (src/secrets.js) and hands the ACP stream to `dsh --profile <profile>-acp` (src/launch.js).
//
// `main` takes its streams and environment as arguments, so a test (and the doctor's own ACP
// probe) never touches the real homes. Nothing here prints a key value: the only key output is
// `maskReport`, which carries names, states and lengths.

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { packageVersion, probeAcp } from './acpProbe.js';
import { buildLaunch, findDsh, launch as launchProfile } from './launch.js';
import { SHIPPED_ACP_PROFILE, dshHome, listProfiles, variantName, variantState } from './profiles.js';
import { DEFAULT_ROUTES, overlayPath, renderOverlay, writeOverlay } from './routes.js';
import { maskReport, missingKeys, resolveKeys } from './secrets.js';
import {
  instanceId,
  isOwnedInstance,
  planSettings,
  readSettings,
  removeOwned,
  t3SettingsPath,
  writeSettings,
} from './t3settings.js';
import { parseSince, readUsage } from './usage.js';
import { applyVariant, planVariant, removeVariant, syncVariant } from './variant.js';

/** Absolute path of the executable T3 spawns (`bin/t3code-bridge-dsh.js`, shebang + mode 755). */
export const BIN_PATH = fileURLToPath(new URL('../bin/t3code-bridge-dsh.js', import.meta.url));

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

/** A flag or argument problem: usage on stderr, exit 2. */
class UsageError extends Error {}

/** A deliberate refusal (bad selection, missing variant, conflict): the reason, exit 1. */
class Refusal extends Error {}

export const USAGE = `t3code-bridge-dsh — run dsh profiles as T3 Code agents over ACP

usage:
  t3code-bridge-dsh profiles                        dsh profiles, ACP variants, T3 instances
  t3code-bridge-dsh routes [--write]                print the model-route overlay (--write: write it)
  t3code-bridge-dsh install (--profile <p> ... | --all) [--dry-run]
  t3code-bridge-dsh uninstall (--profile <p> ... | --all) [--dry-run]
  t3code-bridge-dsh sync [--dry-run]                refresh installed variants from their sources
  t3code-bridge-dsh launch <profile> [--verbose]    run the ACP agent for one profile (T3 spawns this)
  t3code-bridge-dsh doctor [--profile <p> ...]      check dsh, settings, variants, instances, ACP
  t3code-bridge-dsh usage [--since YYYY-MM-DD] [--by model|day] [--json]   token totals from dsh's counter
  t3code-bridge-dsh --help | --version

environment: DSH_HOME (~/.dsh), T3CODE_HOME (~/.t3), XDG_CONFIG_HOME (~/.config)
`;

const COMMANDS = {
  profiles: { run: cmdProfiles, flags: [], positional: 0 },
  routes: { run: cmdRoutes, flags: ['write'], positional: 0 },
  install: { run: cmdInstall, flags: ['profile', 'all', 'dry-run'], positional: 0 },
  uninstall: { run: cmdUninstall, flags: ['profile', 'all', 'dry-run'], positional: 0 },
  sync: { run: cmdSync, flags: ['dry-run'], positional: 0 },
  launch: { run: cmdLaunch, flags: ['verbose'], positional: 1 },
  doctor: { run: cmdDoctor, flags: ['profile'], positional: 0 },
  usage: { run: cmdUsage, flags: ['since', 'by', 'json'], positional: 0 },
};

/**
 * Run one command.
 * @param {string[]} argv command line without `node` and the script path
 * @param {{stdout?: object, stderr?: object, env?: object}} [io]
 * @returns {Promise<number>} the process exit code
 */
export async function main(argv = [], { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  const out = writer(stdout);
  const err = writer(stderr);

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      err(`error: ${error.message}`);
      err(USAGE);
      return EXIT_USAGE;
    }
    throw error;
  }

  const { command, flags, positional } = parsed;
  if (flags.version) {
    out(packageVersion());
    return EXIT_OK;
  }
  if (flags.help) {
    out(USAGE);
    return EXIT_OK;
  }
  if (command === null) {
    err('error: a command is required');
    err(USAGE);
    return EXIT_USAGE;
  }

  const spec = COMMANDS[command];
  if (!spec) {
    err(`error: unknown command: ${command}`);
    err(USAGE);
    return EXIT_USAGE;
  }
  try {
    const used = providedFlags(flags);
    for (const name of used) {
      if (!spec.flags.includes(name)) throw new UsageError(`${command} does not take --${name}`);
    }
    if (positional.length > spec.positional) {
      throw new UsageError(
        spec.positional === 0 ? `${command} takes no arguments` : `${command} takes ${spec.positional} argument`,
      );
    }
  } catch (error) {
    if (error instanceof UsageError) {
      err(`error: ${error.message}`);
      err(USAGE);
      return EXIT_USAGE;
    }
    throw error;
  }

  const ctx = { env, out, err, flags, positional, home: dshHome(env) };
  try {
    return await spec.run(ctx);
  } catch (error) {
    if (error instanceof UsageError) {
      err(`error: ${error.message}`);
      err(USAGE);
      return EXIT_USAGE;
    }
    if (error instanceof Refusal) {
      err(`error: ${error.message}`);
      return EXIT_FAIL;
    }
    err(`error: ${messageOf(error)}`);
    return EXIT_FAIL;
  }
}

// --- commands --------------------------------------------------------------

async function cmdProfiles({ env, home, out }) {
  const profiles = listProfiles({ home });
  const settings = settingsOrNull(env);
  const rows = profiles.map((profile) => {
    const id = safeInstanceId(profile.name);
    const installed = Boolean(id && isOwnedInstance(id, valueOf(settings, id)));
    return [
      profile.name,
      profile.appBundles.length > 0 ? profile.appBundles.join(',') : '-',
      // a variant profile is its own answer; a source profile reports what sits at `<name>-acp`
      profile.isVariant ? 'self' : variantLabel(variantState(profile.name, { home })),
      installed ? 'yes' : 'no',
    ];
  });
  out(renderTable(['NAME', 'APP BUNDLES', 'VARIANT', 'INSTANCE'], rows));
  return EXIT_OK;
}

async function cmdUsage({ flags, home, out }) {
  const since = flags.since === null ? undefined : parseSince(flags.since);
  const by = flags.by ?? 'model';
  let result;
  try {
    result = await readUsage({ home, since, by });
  } catch (error) {
    throw new Refusal(messageOf(error));
  }
  if (flags.json) {
    out(JSON.stringify({ by, since: flags.since, ...result }, null, 2));
    return EXIT_OK;
  }
  const n = (value) => value.toLocaleString('en-US');
  const rows = result.rows.map((r) => [r.group, n(r.calls), n(r.input), n(r.cacheRead), n(r.output)]);
  rows.push(['TOTAL', n(result.total.calls), n(result.total.input), n(result.total.cacheRead), n(result.total.output)]);
  out(renderTable([by === 'day' ? 'DAY' : 'PROVIDER / MODEL / KIND', 'CALLS', 'INPUT', 'CACHE READ', 'OUTPUT'], rows));
  out(`source ${result.path} (dsh's counter has no profile column, so this is not split per profile)`);
  return EXIT_OK;
}

async function cmdRoutes({ env, flags, out }) {
  if (!flags.write) {
    out(renderOverlay().replace(/\n$/, ''));
    return EXIT_OK;
  }
  const target = overlayPath(env);
  const result = writeOverlay(target);
  out(`overlay ${target}: ${result.changed ? 'written' : 'unchanged'}`);
  return EXIT_OK;
}

async function cmdInstall({ env, flags, home, out, err }) {
  const dryRun = flags.dryRun;
  const names = selectProfiles(flags, { home, command: 'install' });

  let failed = 0;
  const installed = [];
  for (const name of names) {
    try {
      const plan = planVariant(name, { home });
      const result = applyVariant(plan, { dryRun });
      const state = result.created ? 'created' : result.updated ? 'updated' : 'unchanged';
      out(`variant ${plan.target}: ${describeState(state, dryRun)} ${plan.targetDir}`);
      installed.push(name);
    } catch (error) {
      failed += 1;
      err(`variant ${name}: refused: ${messageOf(error)}`);
    }
  }

  const overlay = overlayPath(env);
  const overlayResult = writeOverlay(overlay, { dryRun });
  out(`overlay ${overlay}: ${overlayResult.changed ? describeState('written', dryRun) : 'unchanged'}`);

  let summary = { added: 0, changed: 0, unchanged: 0, conflicts: 0, removed: 0 };
  if (installed.length > 0) {
    const settingsPath = t3SettingsPath(env);
    try {
      const current = settingsOrThrow(env);
      // `--profile` is additive: instances this tool installed earlier stay unless `--all`
      // asked for the whole set. planSettings treats `wanted` as the complete set, so the
      // wanted list is the union here and only `--all` can drop an instance.
      const existing = new Set(listProfiles({ home }).map((profile) => profile.name));
      const keep = ownedProfiles(current).filter((profile) => !flags.all || existing.has(profile));
      const plan = planSettings(current, [
        ...keep.map((profile) => ({ profile, binPath: BIN_PATH })),
        ...installed.map((profile) => ({ profile, binPath: BIN_PATH })),
      ]);
      const written = writeSettings(settingsPath, plan.next, { dryRun, expect: current });
      summary = {
        added: plan.added.length,
        changed: plan.changed.length,
        unchanged: plan.unchanged.length,
        conflicts: plan.conflicts.length,
        removed: plan.removedStale.length,
      };
      out(`settings ${settingsPath}: ${describeSettings(plan)}`);
      if (written.backupPath) out(`backup ${written.backupPath}`);
      if (written.dryRun && written.changedKeys.length > 0) out(`would change: ${written.changedKeys.join(', ')}`);
      for (const id of plan.conflicts) {
        failed += 1;
        err(`settings ${id}: refused: a provider instance with that id is not owned by this tool`);
      }
    } catch (error) {
      failed += 1;
      err(`settings ${settingsPath}: ${messageOf(error)}`);
    }
  }

  if (dryRun) out('DRY-RUN: nothing was written');
  out(
    `SUMMARY profiles=${names.length} installed=${installed.length} added=${summary.added} ` +
      `changed=${summary.changed} unchanged=${summary.unchanged} removed=${summary.removed} failed=${failed}`,
  );
  return failed > 0 ? EXIT_FAIL : EXIT_OK;
}

async function cmdUninstall({ env, flags, home, out, err }) {
  const dryRun = flags.dryRun;
  const names = selectProfiles(flags, { home, command: 'uninstall' });

  let failed = 0;
  for (const name of names) {
    try {
      const result = removeVariant(name, { home, dryRun });
      out(`variant ${variantName(name)}: ${result.removed ? describeState('removed', dryRun) : 'absent'}`);
    } catch (error) {
      failed += 1;
      err(`variant ${name}: refused: ${messageOf(error)}`);
    }
  }

  const settingsPath = t3SettingsPath(env);
  let removed = [];
  let remaining = [];
  try {
    const current = settingsOrThrow(env);
    // `--all` is "remove everything this tool created": an owned instance whose profile
    // directory is already gone has no name left to derive an id from, so take them all.
    const ids = flags.all ? undefined : names.map(safeInstanceId).filter(Boolean);
    const result = removeOwned(current, ids);
    removed = result.removed;
    const written = writeSettings(settingsPath, result.next, { dryRun, expect: current });
    out(
      `settings ${settingsPath}: ${removed.length > 0 ? `${dryRun ? 'would remove' : 'removed'} ${removed.join(',')}` : 'no owned instance'}`,
    );
    if (written.backupPath) out(`backup ${written.backupPath}`);
    remaining = ownedIds(result.next);
  } catch (error) {
    failed += 1;
    err(`settings ${settingsPath}: ${messageOf(error)}`);
  }

  const overlay = overlayPath(env);
  if (flags.all && remaining.length === 0) {
    if (!existsSync(overlay)) out(`overlay ${overlay}: absent`);
    else if (dryRun) out(`overlay ${overlay}: would remove`);
    else {
      try {
        rmSync(overlay, { force: true });
        out(`overlay ${overlay}: removed`);
      } catch (error) {
        failed += 1;
        err(`overlay ${overlay}: cannot remove: ${messageOf(error)}`);
      }
    }
  }

  if (dryRun) out('DRY-RUN: nothing was written');
  out(
    `SUMMARY profiles=${names.length} variants=${names.length - failed} instances=${removed.length} ` +
      `remaining=${remaining.length} failed=${failed}`,
  );
  return failed > 0 ? EXIT_FAIL : EXIT_OK;
}

async function cmdSync({ flags, home, out, err }) {
  const dryRun = flags.dryRun;
  const sources = listProfiles({ home })
    .filter((profile) => !profile.isVariant && profile.name !== SHIPPED_ACP_PROFILE)
    .filter((profile) => variantState(profile.name, { home }) === 'owned');

  let failed = 0;
  let changed = 0;
  for (const profile of sources) {
    try {
      const result = syncVariant(profile.name, { home, dryRun });
      if (result.updated) changed += 1;
      const state = result.updated ? 'updated' : 'unchanged';
      out(`variant ${variantName(profile.name)}: ${result.updated ? describeState(state, dryRun) : state}`);
    } catch (error) {
      failed += 1;
      err(`variant ${variantName(profile.name)}: refused: ${messageOf(error)}`);
    }
  }

  if (dryRun) out('DRY-RUN: nothing was written');
  out(`SUMMARY variants=${sources.length} changed=${changed} failed=${failed}`);
  return failed > 0 ? EXIT_FAIL : EXIT_OK;
}

async function cmdLaunch({ env, flags, positional, err }) {
  const profile = positional[0];
  if (!profile) throw new UsageError('launch needs a profile name: t3code-bridge-dsh launch <profile>');

  // buildLaunch is pure: it tells us which keys are missing before the child exists.
  let plan;
  try {
    plan = buildLaunch({ profile, env });
  } catch (error) {
    err(`t3code-bridge-dsh: ${messageOf(error)}`);
    return EXIT_FAIL;
  }
  if (flags.verbose) for (const line of maskReport(plan.report)) err(`t3code-bridge-dsh: ${line}`);
  const missing = missingKeys(plan.report);
  if (missing.length > 0) err(`t3code-bridge-dsh: warning: no key for ${missing.join(', ')}`);

  // Nothing but dsh's own output reaches stdout: this process is the ACP transport.
  return launchProfile({ profile, env });
}

async function cmdDoctor({ env, flags, home, out }) {
  let pass = 0;
  let fail = 0;
  const record = (ok, label, detail) => {
    if (ok) pass += 1;
    else fail += 1;
    out(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  };

  let dshPath = null;
  try {
    dshPath = findDsh(env);
  } catch (error) {
    record(false, 'dsh', messageOf(error));
  }
  if (dshPath) {
    const version = dshVersion(dshPath, env);
    record(version.ok, 'dsh', version.ok ? `${version.text} (${dshPath})` : `${version.error} (${dshPath})`);
  }

  const homeOk = isDirectory(home);
  record(homeOk, 'DSH_HOME', homeOk ? home : `${home} is missing`);

  const settingsPath = t3SettingsPath(env);
  let settings = null;
  try {
    settings = readSettings(settingsPath);
    record(true, 't3 settings', settingsPath);
  } catch (error) {
    record(false, 't3 settings', messageOf(error));
  }

  const { report } = resolveKeys({ env, dshHome: home });
  for (const line of maskReport(report)) out(`      ${line}`);
  // Only the default route's key is required: the other two are selectable backups, so their
  // absence costs model choices, not the bridge. The lines above already show their state.
  const required = requiredKeys();
  const missing = missingKeys(report).filter((name) => required.includes(name));
  record(
    missing.length === 0,
    'keys',
    missing.length === 0 ? `${required.join(', ')} resolved` : `unset: ${missing.join(', ')}`,
  );

  const selected = doctorProfiles(flags, home);
  for (const name of selected) {
    const state = variantState(name, { home });
    record(
      state === 'owned',
      `variant ${variantName(name)}`,
      state === 'owned' ? 'installed' : state === 'unowned' ? 'present, not ours' : 'missing',
    );

    const id = safeInstanceId(name) ?? `dsh-${name}`;
    const value = valueOf(settings, id);
    const owned = Boolean(safeInstanceId(name) && isOwnedInstance(id, value));
    record(owned, `instance ${id}`, owned ? 'installed and owned' : value ? 'present, not ours' : 'missing');

    // The live check: exactly what T3 will run, `node <bin> launch <profile>`.
    const probe = await probeAcp({
      command: process.execPath,
      args: [BIN_PATH, 'launch', name],
      env,
      cwd: home,
      timeoutMs: 30000,
    });
    record(
      probe.ok,
      `acp ${id}`,
      probe.ok
        ? `${(probe.agentInfo && probe.agentInfo.name) || 'agent'} sessions=${probe.sessionCount ?? 0} ${probe.ms}ms`
        : `${probe.error}${probe.agentInfo ? ` (agent: ${probe.agentInfo.name || 'unknown'})` : ''}`,
    );
  }

  out(`SUMMARY pass=${pass} fail=${fail}`);
  return fail > 0 ? EXIT_FAIL : EXIT_OK;
}

// --- selection, formatting, small helpers ---------------------------------

/**
 * Profiles a mutation applies to.
 * `--all` = every profile listProfiles reports as non-variant, minus the shipped `acp`.
 */
function selectProfiles(flags, { home, command }) {
  if (flags.all) {
    if (flags.profile.length > 0) throw new Refusal('use --profile or --all, not both');
    const names = listProfiles({ home })
      .filter((profile) => !profile.isVariant && profile.name !== SHIPPED_ACP_PROFILE)
      .map((profile) => profile.name);
    if (names.length === 0) throw new Refusal(`no dsh profiles to ${command} under ${home}/profiles`);
    return names;
  }
  if (flags.profile.length === 0) throw new Refusal(`pick profiles: --profile <name> (repeatable) or --all`);
  return [...new Set(flags.profile)];
}

/** Profiles doctor looks at: the named ones, or every installed variant. */
function doctorProfiles(flags, home) {
  if (flags.profile.length > 0) return [...new Set(flags.profile)];
  return listProfiles({ home })
    .filter((profile) => !profile.isVariant && profile.name !== SHIPPED_ACP_PROFILE)
    .filter((profile) => variantState(profile.name, { home }) === 'owned')
    .map((profile) => profile.name);
}

/** Env var names the default route needs, straight from the routes table (no second list). */
function requiredKeys() {
  const provider = DEFAULT_ROUTES.providers[DEFAULT_ROUTES.default.provider];
  return provider && typeof provider.apiKeyEnv === 'string' ? [provider.apiKeyEnv] : [];
}

/** Settings object, or `{}` when the file does not exist yet (a first install creates it). */
function settingsOrThrow(env) {
  const settingsPath = t3SettingsPath(env);
  if (!existsSync(settingsPath)) return {};
  return readSettings(settingsPath);
}

/** Settings object, or null when it is missing or unreadable (read-only commands). */
function settingsOrNull(env) {
  try {
    return settingsOrThrow(env);
  } catch {
    return null;
  }
}

function valueOf(settings, id) {
  if (!settings || !settings.providerInstances) return undefined;
  return settings.providerInstances[id];
}

function ownedIds(settings) {
  const instances = settings && settings.providerInstances;
  if (!instances || typeof instances !== 'object') return [];
  return Object.keys(instances).filter((id) => isOwnedInstance(id, instances[id]));
}

/** Profiles of the instances this tool owns: the name the launcher is told to run. */
function ownedProfiles(settings) {
  const instances = settings && settings.providerInstances;
  if (!instances || typeof instances !== 'object') return [];
  const profiles = [];
  for (const id of ownedIds(settings)) {
    const profile = instances[id].config.commandArgs[1];
    if (!profiles.includes(profile)) profiles.push(profile);
  }
  return profiles;
}

function safeInstanceId(name) {
  try {
    return instanceId(name);
  } catch {
    return null;
  }
}

function variantLabel(state) {
  if (state === 'owned') return 'yes';
  if (state === 'unowned') return 'unowned';
  return 'no';
}

/** `created` -> `would create` in a dry run, so a report never claims a write that did not happen. */
function describeState(state, dryRun) {
  if (!dryRun) return state;
  const would = { created: 'would create', updated: 'would update', written: 'would write', removed: 'would remove' };
  return would[state] ?? `would ${state}`;
}

function describeSettings(plan) {
  const bits = [];
  if (plan.added.length > 0) bits.push(`added ${plan.added.join(',')}`);
  if (plan.changed.length > 0) bits.push(`changed ${plan.changed.join(',')}`);
  if (plan.unchanged.length > 0) bits.push(`unchanged ${plan.unchanged.join(',')}`);
  if (plan.removedStale.length > 0) bits.push(`removed ${plan.removedStale.join(',')}`);
  if (plan.conflicts.length > 0) bits.push(`conflicts ${plan.conflicts.join(',')}`);
  return bits.length > 0 ? bits.join('; ') : 'no change';
}

function renderTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index] ?? '').length)),
  );
  const line = (cells) =>
    cells
      .map((cell, index) => String(cell ?? '').padEnd(widths[index]))
      .join('  ')
      .replace(/\s+$/, '');
  return [line(headers), ...rows.map(line)].join('\n');
}

function dshVersion(dshPath, env) {
  try {
    const result = spawnSync(dshPath, ['--version'], { env, encoding: 'utf8', timeout: 20000 });
    if (result.error) return { ok: false, error: `cannot run --version: ${result.error.message}` };
    const text = `${result.stdout || ''}${result.stderr || ''}`.trim().split('\n')[0];
    if (result.status !== 0) {
      return { ok: false, error: `--version exited ${result.status}${text ? `: ${text}` : ''}` };
    }
    return { ok: true, text: text || 'dsh (no version text)' };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

function isDirectory(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** A stream writer that always ends with a newline and ignores a closed pipe (`| head`). */
function writer(stream) {
  return (text) => {
    const line = `${text}`.endsWith('\n') ? `${text}` : `${text}\n`;
    try {
      stream.write(line);
    } catch {
      /* the reader went away: not a failure of this command */
    }
  };
}

function messageOf(error) {
  if (!error) return 'unknown error';
  return typeof error.message === 'string' && error.message !== '' ? error.message : String(error);
}

// --- argument parsing -----------------------------------------------------

function parseArgs(argv) {
  const flags = { since: null, by: null, json: false, profile: [], all: false, dryRun: false, write: false, verbose: false, help: false, version: false };
  const positional = [];
  let command = null;
  const list = Array.isArray(argv) ? argv : [];

  for (let index = 0; index < list.length; index += 1) {
    const arg = String(list[index]);
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--version') {
      flags.version = true;
    } else if (arg === '--all') {
      flags.all = true;
    } else if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--write') {
      flags.write = true;
    } else if (arg === '--verbose') {
      flags.verbose = true;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--since' || arg.startsWith('--since=') || arg === '--by' || arg.startsWith('--by=')) {
      const name = arg.startsWith('--since') ? 'since' : 'by';
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : list[index + 1];
      if (!arg.includes('=')) index += 1;
      if (typeof value !== 'string' || value === '') throw new UsageError(`--${name} needs a value`);
      flags[name] = value;
    } else if (arg === '--profile' || arg.startsWith('--profile=')) {
      const value = arg === '--profile' ? list[index + 1] : arg.slice('--profile='.length);
      if (arg === '--profile') index += 1;
      if (typeof value !== 'string' || value === '') throw new UsageError('--profile needs a value');
      flags.profile.push(value);
    } else if (arg.startsWith('-') && arg !== '-') {
      throw new UsageError(`unknown flag: ${arg}`);
    } else if (command === null) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }
  return { command, flags, positional };
}

function providedFlags(flags) {
  const names = [];
  if (flags.all) names.push('all');
  if (flags.dryRun) names.push('dry-run');
  if (flags.write) names.push('write');
  if (flags.verbose) names.push('verbose');
  if (flags.profile.length > 0) names.push('profile');
  if (flags.since !== null) names.push('since');
  if (flags.by !== null) names.push('by');
  if (flags.json) names.push('json');
  return names;
}

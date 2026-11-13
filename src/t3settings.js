// T3 Code settings: owns only the provider instances this tool created.
//
// Ownership is decided by shape, not by a marker key: T3's settings schema may
// strip unknown config keys, so an id like `dsh-web` could come back without any
// marker we wrote. The rule (see docs/SPEC-M1.md):
//   id matches /^dsh-[a-z0-9][a-z0-9-]*$/  AND  driver === "acpRegistry"
//   AND  config.commandArgs === ["--profile", "<something>-acp"].

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OWNED_ID_RE = /^dsh-[a-z0-9][a-z0-9-]*$/;
const OWNED_PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*-acp$/;
const DRIVER = 'acpRegistry';
const BACKUP_SUFFIX = 'bridge-dsh';

/** Absolute path of the T3 Code settings file. `T3CODE_HOME` points at the T3 home dir. */
export function t3SettingsPath(env = process.env) {
  const home =
    env && typeof env.T3CODE_HOME === 'string' && env.T3CODE_HOME.trim() !== ''
      ? path.resolve(env.T3CODE_HOME)
      : path.join(os.homedir(), '.t3');
  return path.join(home, 'userdata', 'settings.json');
}

/** `"dsh-" + profile` lowercased, every non `[a-z0-9]` run collapsed to `-`. */
export function instanceId(profile) {
  if (typeof profile !== 'string' || profile.trim() === '') {
    throw new Error('a profile name is required to build a T3 instance id');
  }
  const slug = profile
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '') {
    throw new Error(`profile name "${profile}" has no [a-z0-9] characters, cannot build a T3 instance id`);
  }
  return `dsh-${slug}`;
}

/** The provider instance value T3 stores for one dsh profile. */
export function buildInstance({ profile, dshPath, displayName, accentColor } = {}) {
  if (typeof profile !== 'string' || profile.trim() === '') {
    throw new Error('buildInstance: profile is required');
  }
  if (typeof dshPath !== 'string' || dshPath.trim() === '') {
    throw new Error('buildInstance: dshPath is required');
  }
  const value = {
    driver: DRIVER,
    enabled: true,
    displayName: displayName || `DSH ${profile}`,
    config: {
      source: 'local',
      commandPath: dshPath,
      commandArgs: ['--profile', `${profile}-acp`],
      enabled: true,
    },
  };
  // accentColor stays absent unless asked for: T3 treats it as a display key the
  // user may set in its own UI, and an explicit `undefined` would still count as a
  // stored key in a deep comparison.
  if (typeof accentColor === 'string' && accentColor.trim() !== '') value.accentColor = accentColor;
  return value;
}

/** True only for a settings key this tool owns (id shape + driver + command shape). */
export function isOwnedInstance(id, value) {
  if (typeof id !== 'string' || !OWNED_ID_RE.test(id)) return false;
  if (!isPlainObject(value)) return false;
  if (value.driver !== DRIVER) return false;
  const config = value.config;
  if (!isPlainObject(config)) return false;
  const args = config.commandArgs;
  if (!Array.isArray(args) || args.length !== 2) return false;
  if (args[0] !== '--profile') return false;
  return typeof args[1] === 'string' && OWNED_PROFILE_RE.test(args[1]);
}

/**
 * Pure plan for the wanted profiles. Returns
 * `{ next, added, changed, unchanged, removedStale, conflicts }`.
 * Owned instances are merged with the desired value so per-instance state T3
 * added itself (model choice, credentials, ...) survives an install/sync.
 */
export function planSettings(settingsObj, wanted) {
  if (!isPlainObject(settingsObj)) throw new Error('planSettings: settings must be an object');
  if (!Array.isArray(wanted)) throw new Error('planSettings: wanted must be an array');

  const next = structuredClone(settingsObj);
  const hadInstances = next.providerInstances !== undefined && next.providerInstances !== null;
  if (hadInstances && !isPlainObject(next.providerInstances)) {
    throw new Error('planSettings: settings.providerInstances must be an object');
  }
  const instances = { ...(next.providerInstances ?? {}) };

  const added = [];
  const changed = [];
  const unchanged = [];
  const removedStale = [];
  const conflicts = [];
  const wantedIds = new Set();

  for (const item of wanted) {
    const id = instanceId(item && item.profile);
    if (wantedIds.has(id)) continue; // duplicate profile in `wanted`: first wins
    wantedIds.add(id);

    const desired = buildInstance(item);
    const current = instances[id];

    if (current !== undefined && !isOwnedInstance(id, current)) {
      conflicts.push(id); // a foreign instance already uses this id: leave it alone
      continue;
    }
    if (current === undefined) {
      instances[id] = desired;
      added.push(id);
      continue;
    }

    const merged = mergeInstance(current, desired);
    if (stableStringify(merged) === stableStringify(current)) {
      unchanged.push(id);
    } else {
      instances[id] = merged;
      changed.push(id);
    }
  }

  for (const id of Object.keys(instances)) {
    if (wantedIds.has(id)) continue;
    if (!isOwnedInstance(id, instances[id])) continue;
    delete instances[id];
    removedStale.push(id);
  }

  if (hadInstances || Object.keys(instances).length > 0) next.providerInstances = instances;

  return { next, added, changed, unchanged, removedStale, conflicts };
}

/** Pure removal of owned instances (all of them when `ids` is omitted). */
export function removeOwned(settingsObj, ids) {
  if (!isPlainObject(settingsObj)) throw new Error('removeOwned: settings must be an object');
  if (ids !== undefined && !Array.isArray(ids)) throw new Error('removeOwned: ids must be an array when given');

  const next = structuredClone(settingsObj);
  const instances = next.providerInstances;
  if (!isPlainObject(instances)) return { next, removed: [] };

  const candidates = ids === undefined ? Object.keys(instances) : ids.map(String);
  const removed = [];
  for (const id of candidates) {
    if (!Object.prototype.hasOwnProperty.call(instances, id)) continue;
    if (!isOwnedInstance(id, instances[id])) continue;
    delete instances[id];
    removed.push(id);
  }
  return { next, removed };
}

/** Parsed settings object. Throws a clear error when the file is missing or not an object. */
export function readSettings(settingsPath) {
  if (typeof settingsPath !== 'string' || settingsPath.trim() === '') {
    throw new Error('readSettings: path is required');
  }
  const abs = path.resolve(settingsPath);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') throw new Error(`T3 settings file not found: ${abs}`);
    throw new Error(`cannot read T3 settings file ${abs}: ${err && err.message}`);
  }
  return parseSettings(raw, abs);
}

/**
 * Backs up the current file, then writes `next` atomically (temp file in the
 * same dir + rename), 2-space JSON plus a trailing newline, file mode preserved.
 * Invalid current JSON throws before anything is touched. Dry run writes nothing.
 */
export function writeSettings(settingsPath, next, { dryRun = false } = {}) {
  if (typeof settingsPath !== 'string' || settingsPath.trim() === '') {
    throw new Error('writeSettings: path is required');
  }
  if (!isPlainObject(next)) throw new Error('writeSettings: next must be an object');
  const abs = path.resolve(settingsPath);

  const current = readCurrent(abs); // validates the current file before any write
  const created = !current.exists;
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const unchanged = !created && stableStringify(current.value) === stableStringify(next);
  const changedKeys = created ? Object.keys(next).sort() : diffKeys(current.value, next);

  if (dryRun) {
    return { written: false, dryRun: true, path: abs, backupPath: null, created, changedKeys, unchanged };
  }
  if (unchanged) {
    return { written: false, dryRun: false, path: abs, backupPath: null, created, changedKeys: [], unchanged };
  }

  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const backupPath = created ? null : backupFile(abs);
  const mode = current.exists ? current.mode : 0o600;
  const tmp = path.join(dir, `.${path.basename(abs)}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, abs);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw err;
  }
  return { written: true, dryRun: false, path: abs, backupPath, created, changedKeys, unchanged: false };
}

// --- internals -------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeInstance(current, desired) {
  const currentConfig = isPlainObject(current.config) ? current.config : {};
  return { ...current, ...desired, config: { ...currentConfig, ...desired.config } };
}

function parseSettings(raw, abs) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`T3 settings file is empty: ${abs}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in T3 settings file ${abs}: ${err.message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`T3 settings file must contain a JSON object: ${abs}`);
  }
  return parsed;
}

function readCurrent(abs) {
  let stat = null;
  try {
    stat = fs.statSync(abs);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, value: null, mode: 0o600 };
    throw new Error(`cannot stat T3 settings file ${abs}: ${err && err.message}`);
  }
  if (!stat.isFile()) throw new Error(`T3 settings path is not a file: ${abs}`);
  const raw = fs.readFileSync(abs, 'utf8');
  return { exists: true, value: parseSettings(raw, abs), mode: stat.mode & 0o777 };
}

function backupFile(abs) {
  const stamp = timestamp(new Date());
  const base = `${abs}.bak-${stamp}-${BACKUP_SUFFIX}`;
  let candidate = base;
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = `${base}-${n}`;
  fs.copyFileSync(abs, candidate);
  return candidate;
}

function timestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function diffKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = [];
  for (const key of keys) {
    if (stableStringify(before[key]) !== stableStringify(after[key])) out.push(key);
  }
  return out.sort();
}

/** Deterministic stringify: same value -> same string, regardless of key order. */
function stableStringify(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

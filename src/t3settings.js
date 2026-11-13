// T3 Code settings: owns only the provider instances this tool created.
//
// Ownership is decided by shape, not by a marker key: T3's settings schema may
// strip unknown config keys, so an id like `dsh-web` could come back without any
// marker we wrote. The rule (see docs/SPEC-M1.md):
//   id matches /^dsh-[a-z0-9][a-z0-9-]*$/  AND  driver === "acpRegistry"
//   AND  config.commandArgs === ["launch", "<profile>"]  where <profile> is a dsh
//   profile name whose slug equals the id suffix (the launcher appends `-acp`).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OWNED_ID_RE = /^dsh-[a-z0-9][a-z0-9-]*$/;
const OWNED_ID_PREFIX = 'dsh-';
// The shape the launcher accepts (src/launch.js): a dsh profile directory name.
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
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

/** Profile name -> id suffix: lowercased, every non `[a-z0-9]` run collapsed to `-`. */
function profileSlug(profile) {
  return profile
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `"dsh-" + profile` lowercased, every non `[a-z0-9]` run collapsed to `-`. */
export function instanceId(profile) {
  if (typeof profile !== 'string' || profile.trim() === '') {
    throw new Error('a profile name is required to build a T3 instance id');
  }
  const slug = profileSlug(profile);
  if (slug === '') {
    throw new Error(`profile name "${profile}" has no [a-z0-9] characters, cannot build a T3 instance id`);
  }
  return `${OWNED_ID_PREFIX}${slug}`;
}

/**
 * The provider instance value T3 stores for one dsh profile.
 * T3 starts `commandPath commandArgs...`: our launcher, which resolves the keys and execs
 * `dsh --profile <profile>-acp --patch <overlay>`.
 */
export function buildInstance({ profile, binPath, dshPath, displayName, accentColor } = {}) {
  if (typeof profile !== 'string' || profile.trim() === '') {
    throw new Error('buildInstance: profile is required');
  }
  if (!PROFILE_NAME_RE.test(profile)) {
    throw new Error(
      `buildInstance: profile must be a dsh profile name ([a-z0-9][a-z0-9._-]*), got ${profile.length} characters`,
    );
  }
  // `dshPath` is the M1 name and stays a deprecated alias so an old caller keeps working.
  const command = typeof binPath === 'string' && binPath.trim() !== '' ? binPath : dshPath;
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('buildInstance: binPath is required');
  }
  const value = {
    driver: DRIVER,
    enabled: true,
    displayName: displayName || `DSH ${profile}`,
    config: {
      source: 'local',
      commandPath: command,
      commandArgs: ['launch', profile],
      enabled: true,
    },
  };
  // Only a real colour is stored. An absent key keeps the value T3's own UI may
  // have written (mergeInstance drops `undefined`), and it keeps the built value
  // deep-equal to what a JSON round trip gives back.
  if (typeof accentColor === 'string' && accentColor.trim() !== '') value.accentColor = accentColor;
  return value;
}

/** True only for a settings key this tool owns (id shape + driver + launch command shape). */
export function isOwnedInstance(id, value) {
  if (typeof id !== 'string' || !OWNED_ID_RE.test(id)) return false;
  if (!isPlainObject(value)) return false;
  if (value.driver !== DRIVER) return false;
  const config = value.config;
  if (!isPlainObject(config)) return false;
  const args = config.commandArgs;
  if (!Array.isArray(args) || args.length !== 2) return false;
  if (args[0] !== 'launch') return false;
  const profile = args[1];
  if (typeof profile !== 'string' || !PROFILE_NAME_RE.test(profile)) return false;
  // The profile the launcher runs is the one the id was derived from: an instance whose
  // command and id disagree is not a pair we wrote, so it stays someone else's.
  return profileSlug(profile) === id.slice(OWNED_ID_PREFIX.length);
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
  const wantedIds = new Map(); // id -> profile that claimed it

  for (const item of wanted) {
    const profile = item && item.profile;
    if (typeof profile !== 'string' || !PROFILE_NAME_RE.test(profile)) {
      // A name the launcher cannot run must not become an instance we then fail to own.
      let id = '(invalid profile name)';
      try {
        id = instanceId(profile);
      } catch {
        /* keep the placeholder */
      }
      conflicts.push(id);
      continue;
    }
    const id = instanceId(profile);
    if (wantedIds.has(id)) {
      // the same profile twice is just a repeated input; two different profiles
      // that slug to one id would silently overwrite each other, so report it
      if (wantedIds.get(id) !== profile) conflicts.push(id);
      continue;
    }
    wantedIds.set(id, profile);

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

  // An empty `wanted` is "nothing selected", not "remove everything": `uninstall` does that.
  for (const id of wantedIds.size === 0 ? [] : Object.keys(instances)) {
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
export function writeSettings(settingsPath, next, { dryRun = false, expect } = {}) {
  if (typeof settingsPath !== 'string' || settingsPath.trim() === '') {
    throw new Error('writeSettings: path is required');
  }
  if (!isPlainObject(next)) throw new Error('writeSettings: next must be an object');
  // A symlinked settings.json (dotfile managers) must stay a symlink: write to its target.
  let abs = path.resolve(settingsPath);
  try {
    abs = fs.realpathSync(abs);
  } catch {
    /* missing file: created below */
  }

  const current = readCurrent(abs); // validates the current file before any write
  // Optimistic lock: `expect` is the object `next` was derived from. If T3 rewrote the file
  // since the caller read it, writing `next` would silently drop T3's change.
  if (expect !== undefined && current.exists && stableStringify(current.value) !== stableStringify(expect)) {
    throw new Error(`T3 settings changed while the plan was being made, nothing written: ${abs} (run again)`);
  }
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
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, mode);
    // last look right before the swap: shrink the race window to the rename itself
    if (current.exists && fs.readFileSync(abs, 'utf8') !== current.raw) {
      throw new Error(`T3 settings changed during the write, nothing written: ${abs} (run again)`);
    }
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

/**
 * Re-apply only what makes the instance run our launcher (driver, source, command,
 * args). Everything else (enabled, displayName, accentColor, anything T3 or the user
 * added) stays as the user left it; a field is filled only when it is missing.
 */
function mergeInstance(current, desired) {
  const currentConfig = isPlainObject(current.config) ? current.config : {};
  const dc = desired.config ?? {};
  const config = { ...currentConfig, source: dc.source, commandPath: dc.commandPath, commandArgs: dc.commandArgs };
  if (config.enabled === undefined && dc.enabled !== undefined) config.enabled = dc.enabled;
  const merged = { ...current, driver: desired.driver, config };
  for (const [key, item] of Object.entries(desired)) {
    if (key === 'driver' || key === 'config' || item === undefined) continue;
    if (merged[key] === undefined) merged[key] = item;
  }
  return merged;
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
  return { exists: true, value: parseSettings(raw, abs), raw, mode: stat.mode & 0o777 };
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

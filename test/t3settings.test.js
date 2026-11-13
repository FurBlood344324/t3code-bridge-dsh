import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import {
  buildInstance,
  instanceId,
  isOwnedInstance,
  planSettings,
  readSettings,
  removeOwned,
  t3SettingsPath,
  writeSettings,
} from '../src/t3settings.js';

function tempDir(prefix = 't3settings-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const DSH = '/usr/local/bin/dsh';
const BIN = '/home/me/projects/t3code-bridge-dsh/bin/t3code-bridge-dsh.js';

function wanted(profile, extra = {}) {
  return { profile, binPath: BIN, ...extra };
}

function owned(profile, extra = {}) {
  return buildInstance(wanted(profile, extra));
}

test('t3SettingsPath: T3CODE_HOME wins, otherwise ~/.t3', () => {
  assert.equal(
    t3SettingsPath({ T3CODE_HOME: '/tmp/t3-home' }),
    path.join(path.resolve('/tmp/t3-home'), 'userdata', 'settings.json'),
  );
  assert.equal(
    t3SettingsPath({ HOME: '/tmp/h' }),
    path.join(os.homedir(), '.t3', 'userdata', 'settings.json'),
  );
  assert.equal(t3SettingsPath({ T3CODE_HOME: '' }), path.join(os.homedir(), '.t3', 'userdata', 'settings.json'));
});

test('instanceId: lowercase dsh prefix, non alphanumerics collapsed', () => {
  assert.equal(instanceId('web'), 'dsh-web');
  assert.equal(instanceId('DS Bot'), 'dsh-ds-bot');
  assert.equal(instanceId('open_design.v2'), 'dsh-open-design-v2');
  assert.equal(instanceId('  Acp  '), 'dsh-acp');
  assert.throws(() => instanceId(''), /profile name|required/i);
  assert.throws(() => instanceId('---'), /no \[a-z0-9\]/i);
});

test('buildInstance: ACP registry shape running the bridge launcher', () => {
  const value = buildInstance({ profile: 'web', binPath: BIN, accentColor: '#123456' });
  assert.deepEqual(value, {
    driver: 'acpRegistry',
    enabled: true,
    displayName: 'DSH web',
    accentColor: '#123456',
    config: {
      source: 'local',
      commandPath: BIN,
      commandArgs: ['launch', 'web'],
      enabled: true,
    },
  });
  assert.equal(buildInstance({ profile: 'web', binPath: BIN }).accentColor, undefined);
  assert.throws(() => buildInstance({ binPath: BIN }), /profile is required/);
  assert.throws(() => buildInstance({ profile: 'web' }), /binPath is required/);
  assert.throws(() => buildInstance({ profile: 'Web', binPath: BIN }), /must be a dsh profile name/);
  assert.throws(() => buildInstance({ profile: 'web acp', binPath: BIN }), /must be a dsh profile name/);
  // the M1 key still works as a deprecated alias
  assert.equal(buildInstance({ profile: 'web', dshPath: DSH }).config.commandPath, DSH);
  assert.equal(buildInstance({ profile: 'web', binPath: BIN, dshPath: DSH }).config.commandPath, BIN);
});

test('isOwnedInstance: id shape + driver + launch <profile>, and the slug must match the id', () => {
  assert.equal(isOwnedInstance('dsh-web', owned('web')), true);
  assert.equal(isOwnedInstance('dsh-dsh-tui', owned('dsh.tui')), true);
  // foreign ids / other drivers / other commands are never owned
  assert.equal(isOwnedInstance('Web', owned('web')), false);
  assert.equal(isOwnedInstance('other-agent', owned('web')), false);
  assert.equal(isOwnedInstance('dsh-web', { ...owned('web'), driver: 'claudeAgent' }), false);
  assert.equal(
    isOwnedInstance('dsh-web', {
      ...owned('web'),
      config: { ...owned('web').config, commandArgs: ['--profile', 'web-acp'] },
    }),
    false,
    'the M1 shape is not the shape we write any more',
  );
  assert.equal(
    isOwnedInstance('dsh-web', {
      ...owned('web'),
      config: { ...owned('web').config, commandArgs: ['launch', 'web', '--x'] },
    }),
    false,
  );
  assert.equal(
    isOwnedInstance('dsh-web', { ...owned('web'), config: { ...owned('web').config, commandArgs: ['launch', 'web-acp'] } }),
    false,
    'the launcher takes the source profile name, not the variant',
  );
  // an instance whose command and id disagree is not a pair we wrote
  assert.equal(
    isOwnedInstance('dsh-web', { ...owned('web'), config: { ...owned('web').config, commandArgs: ['launch', 'dsbot'] } }),
    false,
  );
  assert.equal(
    isOwnedInstance('dsh-web', { ...owned('web'), config: { ...owned('web').config, commandArgs: ['launch', 'Web'] } }),
    false,
  );
  assert.equal(
    isOwnedInstance('dsh-web', { ...owned('web'), config: { ...owned('web').config, commandArgs: ['launch', ''] } }),
    false,
  );
  assert.equal(isOwnedInstance('dsh-web', null), false);
  assert.equal(isOwnedInstance('dsh-web', 'nope'), false);
  assert.equal(isOwnedInstance('dsh-web', { ...owned('web'), config: {} }), false);
});

test('planSettings: adds, reports unchanged, changes, and removes stale owned instances', () => {
  const settings = {
    theme: 'dark',
    providerInstances: {
      'dsh-web': owned('web'),
      'dsh-old': owned('old'),
      'claude-1': { driver: 'claudeAgent', displayName: 'Claude' },
    },
  };
  const plan = planSettings(settings, [wanted('web'), wanted('dsbot')]);

  assert.deepEqual(plan.added, ['dsh-dsbot']);
  assert.deepEqual(plan.changed, []);
  assert.deepEqual(plan.unchanged, ['dsh-web']);
  assert.deepEqual(plan.removedStale, ['dsh-old']);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(Object.keys(plan.next.providerInstances).sort(), ['claude-1', 'dsh-dsbot', 'dsh-web']);
  assert.equal(plan.next.theme, 'dark');
  // pure: the input keeps its own instances
  assert.deepEqual(Object.keys(settings.providerInstances).sort(), ['claude-1', 'dsh-old', 'dsh-web']);
});

test('planSettings: the launcher path is re-applied, but a user-chosen displayName is kept', () => {
  const settings = { providerInstances: { 'dsh-web': owned('web', { displayName: 'Old name' }) } };

  const renamed = planSettings(settings, [wanted('web', { displayName: 'DSH web (beta)' })]);
  assert.deepEqual(renamed.unchanged, ['dsh-web']);
  assert.equal(renamed.next.providerInstances['dsh-web'].displayName, 'Old name');

  const moved = planSettings(settings, [{ profile: 'web', binPath: '/opt/bridge/bin/t3code-bridge-dsh.js' }]);
  assert.deepEqual(moved.changed, ['dsh-web']);
  assert.equal(moved.next.providerInstances['dsh-web'].config.commandPath, '/opt/bridge/bin/t3code-bridge-dsh.js');
  assert.deepEqual(moved.next.providerInstances['dsh-web'].config.commandArgs, ['launch', 'web']);
});

test('planSettings: keeps per-instance state T3 added to an owned instance', () => {
  const current = owned('web');
  current.config.model = 'deepseek/deepseek-chat';
  const plan = planSettings({ providerInstances: { 'dsh-web': current } }, [wanted('web')]);
  assert.deepEqual(plan.unchanged, ['dsh-web']);
  assert.equal(plan.next.providerInstances['dsh-web'].config.model, 'deepseek/deepseek-chat');
});

test('planSettings: an accent colour the user set in T3 is not wiped by a bare wanted entry', () => {
  const current = owned('web', { accentColor: '#ff0000' });
  const plan = planSettings({ providerInstances: { 'dsh-web': current } }, [wanted('web')]);
  assert.deepEqual(plan.unchanged, ['dsh-web']);
  assert.equal(plan.next.providerInstances['dsh-web'].accentColor, '#ff0000');

  // a colour the user already has wins over the one in `wanted`
  const recoloured = planSettings({ providerInstances: { 'dsh-web': current } }, [wanted('web', { accentColor: '#00ff00' })]);
  assert.deepEqual(recoloured.unchanged, ['dsh-web']);
  assert.equal(recoloured.next.providerInstances['dsh-web'].accentColor, '#ff0000');
});

test('planSettings: a foreign instance on the same id is a conflict and stays untouched', () => {
  const foreign = { driver: 'codex', displayName: 'Mine', config: { command: 'codex' } };
  const settings = { providerInstances: { 'dsh-web': foreign, 'dsh-keep': owned('keep') } };
  const plan = planSettings(settings, [wanted('web'), wanted('keep')]);

  assert.deepEqual(plan.conflicts, ['dsh-web']);
  assert.deepEqual(plan.added, []);
  assert.deepEqual(plan.changed, []);
  assert.deepEqual(plan.removedStale, []);
  assert.deepEqual(plan.next.providerInstances['dsh-web'], foreign);
});

test('planSettings: two different profiles that slug to one id are a reported conflict, not a silent overwrite', () => {
  const plan = planSettings({}, [wanted('dsh.tui'), wanted('dsh-tui')]);
  assert.deepEqual(plan.added, ['dsh-dsh-tui']);
  assert.deepEqual(plan.conflicts, ['dsh-dsh-tui']);
  assert.deepEqual(plan.next.providerInstances['dsh-dsh-tui'].config.commandArgs, ['launch', 'dsh.tui']);

  const repeat = planSettings({}, [wanted('web'), wanted('web')]);
  assert.deepEqual(repeat.added, ['dsh-web']);
  assert.deepEqual(repeat.conflicts, [], 'the very same profile twice is not a conflict');
});

test('planSettings: creates providerInstances when the settings have none', () => {
  const plan = planSettings({ theme: 'light' }, [wanted('web')]);
  assert.deepEqual(plan.added, ['dsh-web']);
  assert.ok(plan.next.providerInstances);
  assert.deepEqual(planSettings({}, []).next, {});
});

test('planSettings: rejects malformed input', () => {
  assert.throws(() => planSettings(null, []), /settings must be an object/);
  assert.throws(() => planSettings({}, 'x'), /wanted must be an array/);
  assert.throws(() => planSettings({ providerInstances: [] }, []), /providerInstances must be an object/);
});

test('removeOwned: removes owned ids only, leaves foreign keys', () => {
  const settings = {
    theme: 'dark',
    providerInstances: {
      'dsh-web': owned('web'),
      'dsh-dsbot': owned('dsbot'),
      'claude-1': { driver: 'claudeAgent' },
      'dsh-mine': { driver: 'acpRegistry', config: { source: 'local', commandArgs: ['--profile', 'x'] } },
    },
  };

  const all = removeOwned(settings);
  assert.deepEqual(all.removed.sort(), ['dsh-dsbot', 'dsh-web']);
  assert.deepEqual(Object.keys(all.next.providerInstances).sort(), ['claude-1', 'dsh-mine']);
  assert.equal(all.next.theme, 'dark');
  assert.equal(settings.providerInstances['dsh-web'] !== undefined, true);

  const one = removeOwned(settings, ['dsh-web', 'claude-1', 'nope']);
  assert.deepEqual(one.removed, ['dsh-web']);
  assert.equal(one.next.providerInstances['claude-1'] !== undefined, true);

  const none = removeOwned({ theme: 'dark' });
  assert.deepEqual(none.removed, []);
  assert.deepEqual(none.next, { theme: 'dark' });

  assert.throws(() => removeOwned({}, 'dsh-web'), /ids must be an array/);
});

test('readSettings: parses, and throws a clear error for missing or non-object files', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');

  fs.writeFileSync(file, '{"theme":"dark"}\n');
  assert.deepEqual(readSettings(file), { theme: 'dark' });

  fs.writeFileSync(file, '[]\n');
  assert.throws(() => readSettings(file), /must contain a JSON object/);

  fs.writeFileSync(file, '{oops\n');
  assert.throws(() => readSettings(file), /invalid JSON/);

  assert.throws(() => readSettings(path.join(dir, 'absent.json')), /not found/);
});

test('writeSettings: backs up, writes atomically, keeps unrelated keys, preserves mode', () => {
  const dir = tempDir();
  const file = path.join(dir, 'userdata', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ theme: 'dark', window: { width: 1200 } }, null, 2)}\n`);
  fs.chmodSync(file, 0o640);
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));

  const plan = planSettings(before, [wanted('web')]);
  const result = writeSettings(file, plan.next);

  assert.equal(result.written, true);
  assert.equal(result.created, false);
  assert.ok(result.backupPath && fs.existsSync(result.backupPath), 'backup file exists');
  assert.match(path.basename(result.backupPath), /^settings\.json\.bak-\d{8}-\d{6}-bridge-dsh$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.backupPath, 'utf8')), before);

  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.endsWith('}\n'), 'trailing newline');
  assert.ok(raw.includes('\n  "theme": "dark"'), '2-space JSON');
  const after = JSON.parse(raw);
  assert.deepEqual(after.window, before.window, 'unrelated keys survive byte-for-byte in the parsed object');
  assert.deepEqual(after.providerInstances['dsh-web'], owned('web'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o640, 'file mode preserved');
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).sort(),
    ['settings.json', path.basename(result.backupPath)].sort(),
    'no temp file left behind',
  );
});

test('writeSettings: uses temp file + rename, and a failing rename leaves the original intact', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  const original = '{"theme":"dark"}\n';
  fs.writeFileSync(file, original);

  const rename = mock.method(fs, 'renameSync', () => {
    throw new Error('boom');
  });
  test.after(() => rename.mock.restore());

  assert.throws(() => writeSettings(file, { theme: 'light' }), /boom/);
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'original untouched when the rename fails');
  assert.deepEqual(
    fs.readdirSync(dir).filter((entry) => entry.includes('.tmp-')),
    [],
    'temp file cleaned up',
  );
});

test('writeSettings: refuses invalid JSON without touching the file or making a backup', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"theme": ');
  const before = fs.readFileSync(file, 'utf8');
  const mtime = fs.statSync(file).mtimeMs;

  assert.throws(() => writeSettings(file, { theme: 'light' }), /invalid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.deepEqual(fs.readdirSync(dir), ['settings.json'], 'no backup written');
});

test('writeSettings: dry run writes nothing and returns the diff summary', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"theme":"dark"}\n');

  const result = writeSettings(file, { theme: 'light', extra: 1 }, { dryRun: true });
  assert.equal(result.written, false);
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.changedKeys, ['extra', 'theme']);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"theme":"dark"}\n');
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
});

test('writeSettings: an unchanged object writes nothing and makes no backup', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, `${JSON.stringify({ theme: 'dark', providerInstances: {} }, null, 2)}\n`);

  const result = writeSettings(file, { theme: 'dark', providerInstances: {} });
  assert.equal(result.written, false);
  assert.equal(result.unchanged, true);
  assert.equal(result.backupPath, null);
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
});

test('writeSettings: creates the file (and its dirs) when missing, without a backup', () => {
  const dir = tempDir();
  const file = path.join(dir, 'nested', 'userdata', 'settings.json');

  const result = writeSettings(file, { providerInstances: { 'dsh-web': owned('web') } });
  assert.equal(result.written, true);
  assert.equal(result.created, true);
  assert.equal(result.backupPath, null);
  assert.deepEqual(readSettings(file).providerInstances['dsh-web'], owned('web'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'new file is private');
});

test('planSettings: the profile name reaches the command as written, only the id is slugged', () => {
  const plan = planSettings({}, [wanted('dsh.tui')]);
  const value = plan.next.providerInstances['dsh-dsh-tui'];
  assert.deepEqual(value.config.commandArgs, ['launch', 'dsh.tui']);
  assert.equal(value.displayName, 'DSH dsh.tui');
});

test('planSettings: a profile name the launcher cannot run is a conflict, never an instance', () => {
  const plan = planSettings({}, [wanted('DS Bot'), wanted('')]);
  assert.deepEqual(plan.added, []);
  assert.deepEqual(plan.conflicts, ['dsh-ds-bot', '(invalid profile name)']);
  assert.deepEqual(Object.keys(plan.next.providerInstances ?? {}), []);
});

test('writeSettings: a second sync of the same profiles is a no-op (idempotent through the file)', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`);

  writeSettings(file, planSettings(readSettings(file), [wanted('web'), wanted('dsbot')]).next);
  const first = fs.readFileSync(file, 'utf8');

  const second = planSettings(readSettings(file), [wanted('web'), wanted('dsbot')]);
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.changed, []);
  assert.deepEqual(second.unchanged.sort(), ['dsh-dsbot', 'dsh-web']);
  assert.deepEqual(second.removedStale, []);

  const result = writeSettings(file, second.next);
  assert.equal(result.written, false);
  assert.equal(result.unchanged, true);
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  assert.equal(fs.readdirSync(dir).filter((entry) => entry.includes('.bak-')).length, 1, 'no second backup');
});

test('writeSettings: install then uninstall round-trips the user settings', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  const user = { theme: 'dark', providerInstances: { 'claude-1': { driver: 'claudeAgent' } } };
  fs.writeFileSync(file, `${JSON.stringify(user, null, 2)}\n`);

  writeSettings(file, planSettings(readSettings(file), [wanted('web'), wanted('dsbot')]).next);
  assert.deepEqual(Object.keys(readSettings(file).providerInstances).sort(), ['claude-1', 'dsh-dsbot', 'dsh-web']);

  const removal = removeOwned(readSettings(file));
  writeSettings(file, removal.next);
  assert.deepEqual(removal.removed.sort(), ['dsh-dsbot', 'dsh-web']);
  assert.deepEqual(readSettings(file), user);
});

test('planSettings: user-disabled instance stays disabled; empty wanted prunes nothing', () => {
  const current = owned('web');
  current.enabled = false;
  current.config.enabled = false;
  const plan = planSettings({ providerInstances: { 'dsh-web': current } }, [wanted('web')]);
  assert.deepEqual(plan.unchanged, ['dsh-web']);
  assert.equal(plan.next.providerInstances['dsh-web'].enabled, false);
  const none = planSettings({ providerInstances: { 'dsh-web': current } }, []);
  assert.deepEqual(none.removedStale, []);
  assert.ok(none.next.providerInstances['dsh-web']);
});

test('writeSettings: refuses to overwrite a file that changed since it was read (expect)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-expect-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ a: 1 }));
  const seen = readSettings(file);
  fs.writeFileSync(file, JSON.stringify({ a: 1, t3Added: true }));
  assert.throws(() => writeSettings(file, { a: 2 }, { expect: seen }), /changed while the plan/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, t3Added: true });
});

test('writeSettings: a symlinked settings file stays a symlink and its target is updated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-link-'));
  const target = path.join(dir, 'real.json');
  const link = path.join(dir, 'settings.json');
  fs.writeFileSync(target, JSON.stringify({ a: 1 }));
  fs.symlinkSync(target, link);
  writeSettings(link, { a: 2 });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { a: 2 });
});

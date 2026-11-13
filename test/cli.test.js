// Tests for Module D: the CLI (profiles/routes/install/uninstall/sync/doctor) and its launcher
// entry point. Every path under test is a temp dir; the `dsh` on PATH is a fake shell script that
// execs a fake ACP agent, so nothing here reads a real home or talks to a model.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { BIN_PATH, main } from '../src/cli.js';
import { instanceId } from '../src/t3settings.js';
import { variantName } from '../src/profiles.js';

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const FAKE = {
  opendesign: 'fake-opendesign-key-111111',
  commandCode: 'fake-commandcode-key-2222',
  opencode: 'fake-opencode-key-33333',
};

function tempDir(prefix = 'bridge-cli-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeFile(path, text, mode) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  if (mode) chmodSync(path, mode);
  return path;
}

/** A fake ACP agent: answers initialize + session/list, prints a version for `--version`. */
const AGENT = `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('0.2.2-rc.1\\n');
  process.exit(0);
}
const log = process.env.FAKE_DSH_LOG;
if (log) fs.appendFileSync(log, JSON.stringify(args) + '\\n');
if (process.env.FAKE_DSH_EXIT) process.exit(Number(process.env.FAKE_DSH_EXIT));
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
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'deepseek-harness-acp', version: '0.2.2-rc.1' },
          agentCapabilities: { sessionCapabilities: { close: {}, resume: {}, list: {} } },
        },
      }) + '\\n');
    } else if (msg.method === 'session/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessions: [] } }) + '\\n');
    }
  }
});
`;

function profileJson(name, bundles) {
  return `${JSON.stringify({ name: `dsh-profile-${name}`, version: '1.0.0', dsh: { profile: { bundles } } }, null, 2)}\n`;
}

/**
 * One complete fake environment: DSH_HOME with profiles, a T3 home with user settings, an XDG
 * config home, and a `dsh` on PATH that execs the fake agent.
 */
function fixture({ foreignInstance = true } = {}) {
  const root = tempDir();
  const dshHome = join(root, 'dsh');
  const t3Home = join(root, 't3');
  const xdg = join(root, 'xdg');
  const bin = join(root, 'bin');
  const agentPath = writeFile(join(root, 'fake-agent.mjs'), AGENT);

  const profiles = join(dshHome, 'profiles');
  for (const name of ['web', 'dsbot']) {
    writeFile(
      join(profiles, name, 'package.json'),
      profileJson(name, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-beyin']),
    );
    writeFile(join(profiles, name, 'cordis.patch.yml'), '- id: plugin-a\n  config: {}\n');
    mkdirSync(join(profiles, name, 'node_modules'), { recursive: true });
  }
  writeFile(
    join(profiles, 'acp', 'package.json'),
    profileJson('acp', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app']),
  );
  writeFile(join(dshHome, '.env'), `OPEN_DESIGN_API_KEY=${FAKE.opendesign}\nCOMMAND_CODE_API_KEY=${FAKE.commandCode}\n`);

  const userSettings = {
    theme: 'dark',
    window: { width: 1200 },
    providerInstances: {
      'claude-1': { driver: 'claudeAgent', displayName: 'Claude' },
      ...(foreignInstance
        ? { 'dsh-foo': { driver: 'acpRegistry', displayName: 'Mine', config: { source: 'local', commandArgs: ['launch', 'bar'] } } }
        : {}),
    },
  };
  const settingsPath = writeFile(join(t3Home, 'userdata', 'settings.json'), `${JSON.stringify(userSettings, null, 2)}\n`);

  const dshPath = writeFile(
    join(bin, 'dsh'),
    ['#!/bin/sh', `exec "${process.execPath}" "${agentPath}" "$@"`, ''].join('\n'),
    0o755,
  );

  const env = {
    HOME: root,
    PATH: `${bin}:/usr/bin:/bin`,
    DSH_HOME: dshHome,
    T3CODE_HOME: t3Home,
    XDG_CONFIG_HOME: xdg,
  };
  return { root, dshHome, t3Home, xdg, bin, dshPath, settingsPath, userSettings, env, profiles };
}

/** Collects what a command prints. */
function capture() {
  const chunks = [];
  return {
    chunks,
    write(text) {
      chunks.push(String(text));
      return true;
    },
    get text() {
      return chunks.join('');
    },
  };
}

async function run(args, env) {
  const stdout = capture();
  const stderr = capture();
  const code = await main(args, { stdout, stderr, env });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

const overlayOf = (fx) => join(fx.xdg, 't3code-bridge-dsh', 'routes.yml');
const settingsJson = (fx) => JSON.parse(readFileSync(fx.settingsPath, 'utf8'));
const backups = (fx) => readdirSync(join(fx.t3Home, 'userdata')).filter((name) => name.includes('.bak-'));

describe('profiles', () => {
  test('lists dsh profiles with app bundles, variant state and instance state', async () => {
    const fx = fixture();
    writeFile(join(fx.profiles, 'web-acp', 'package.json'), profileJson('web-acp', ['@deepseek-ai/dsh-base']));
    writeFile(join(fx.profiles, 'web-acp', '.t3code-bridge-dsh'), '{"source":"web"}\n');

    const result = await run(['profiles'], fx.env);
    assert.equal(result.code, 0);
    const lines = result.stdout.trim().split('\n');
    assert.match(lines[0], /^NAME\s+APP BUNDLES\s+VARIANT\s+INSTANCE$/);

    const web = lines.find((line) => line.startsWith('web  '));
    assert.ok(web, `web row missing from:\n${result.stdout}`);
    assert.match(web, /@deepseek-ai\/dsh-web-app/);
    assert.match(web, /yes/);
    // the variant itself is listed as a profile too, and marked as one rather than as its own variant
    assert.ok(lines.some((line) => line.startsWith('web-acp') && /self/.test(line)), result.stdout);
    // the shipped acp profile never gets a variant recommendation
    assert.ok(lines.some((line) => line.startsWith('acp  ')));
    assert.notEqual(result.stdout.includes('dsh-foo'), true, 'a foreign instance is not claimed as installed');
  });

  test('an empty DSH_HOME prints the header only, exit 0, no stack trace', async () => {
    const root = tempDir();
    const env = { HOME: root, PATH: '/usr/bin:/bin', DSH_HOME: join(root, 'dsh'), T3CODE_HOME: join(root, 't3') };
    const result = await run(['profiles'], env);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), 'NAME  APP BUNDLES  VARIANT  INSTANCE');
    assert.equal(result.stderr, '');
  });
});

describe('routes', () => {
  test('prints the overlay and --write writes it to the XDG path', async () => {
    const fx = fixture();
    const printed = await run(['routes'], fx.env);
    assert.equal(printed.code, 0);
    assert.match(printed.stdout, /^# generated by t3code-bridge-dsh/m);
    assert.match(printed.stdout, /llm-pi-ai/);
    assert.equal(existsSync(overlayOf(fx)), false, 'printing writes nothing');

    const written = await run(['routes', '--write'], fx.env);
    assert.equal(written.code, 0);
    assert.equal(readFileSync(overlayOf(fx), 'utf8'), `${printed.stdout.replace(/\n$/, '')}\n`);
    assert.match(written.stdout, /unchanged|written/);

    const again = await run(['routes', '--write'], fx.env);
    assert.match(again.stdout, /unchanged/);
  });
});

describe('install', () => {
  test('--dry-run reports the plan and writes nothing at all', async () => {
    const fx = fixture();
    const before = readFileSync(fx.settingsPath, 'utf8');

    const result = await run(['install', '--profile', 'web', '--dry-run'], fx.env);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /DRY-RUN: nothing was written/);
    assert.match(result.stdout, /would create/);
    assert.equal(existsSync(join(fx.profiles, 'web-acp')), false, 'no variant dir');
    assert.equal(existsSync(overlayOf(fx)), false, 'no overlay');
    assert.equal(readFileSync(fx.settingsPath, 'utf8'), before, 'settings untouched');
    assert.deepEqual(backups(fx), [], 'no backup');
  });

  test('--profile creates the variant, the overlay and the launcher instance, with a settings backup', async () => {
    const fx = fixture();

    const result = await run(['install', '--profile', 'web'], fx.env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /variant web-acp: created/);
    assert.match(result.stdout, /overlay .*routes\.yml: written/);
    assert.match(result.stdout, /settings .*settings\.json: added dsh-web/);
    assert.match(result.stdout, /^SUMMARY /m);

    // the variant is a real profile dir with the ownership marker and the ACP app bundle
    const variantDir = join(fx.profiles, 'web-acp');
    assert.equal(existsSync(join(variantDir, '.t3code-bridge-dsh')), true);
    const variantPkg = JSON.parse(readFileSync(join(variantDir, 'package.json'), 'utf8'));
    assert.ok(variantPkg.dsh.profile.bundles.includes('@deepseek-ai/dsh-acp-app'));
    assert.equal(variantPkg.dsh.profile.bundles.includes('@deepseek-ai/dsh-web-app'), false);
    assert.ok(variantPkg.dsh.profile.bundles.includes('@deepseek-ai/dsh-beyin'), 'plugin bundles survive');

    // the overlay exists and carries env var names only
    assert.match(readFileSync(overlayOf(fx), 'utf8'), /apiKeyEnv: OPEN_DESIGN_API_KEY/);
    for (const value of Object.values(FAKE)) {
      assert.equal(readFileSync(overlayOf(fx), 'utf8').includes(value), false, 'a key value reached the overlay');
    }

    // the instance runs our launcher, not raw dsh
    const after = settingsJson(fx);
    assert.deepEqual(after.providerInstances['dsh-web'], {
      driver: 'acpRegistry',
      enabled: true,
      displayName: 'DSH web',
      config: { source: 'local', commandPath: BIN_PATH, commandArgs: ['launch', 'web'], enabled: true },
    });
    assert.ok(BIN_PATH.endsWith(join('bin', 't3code-bridge-dsh.js')));
    assert.equal(readFileSync(BIN_PATH, 'utf8').split('\n')[0], '#!/usr/bin/env node');
    assert.equal(existsSync(BIN_PATH), true);
    // ... and does not print a key value anywhere
    for (const value of Object.values(FAKE)) assert.equal(result.stdout.includes(value), false);

    // unrelated settings and foreign instances survive
    assert.equal(after.theme, 'dark');
    assert.deepEqual(after.window, { width: 1200 });
    assert.equal(after.providerInstances['dsh-foo'].displayName, 'Mine');

    // a backup holds the previous content
    const found = backups(fx);
    assert.equal(found.length, 1);
    assert.match(found[0], /^settings\.json\.bak-\d{8}-\d{6}-bridge-dsh$/);
    assert.deepEqual(JSON.parse(readFileSync(join(fx.t3Home, 'userdata', found[0]), 'utf8')), fx.userSettings);
  });

  test('--profile is additive: installing one profile later does not drop an earlier instance', async () => {
    const fx = fixture();
    assert.equal((await run(['install', '--all'], fx.env)).code, 0);
    assert.equal((await run(['uninstall', '--profile', 'dsbot'], fx.env)).code, 0);
    assert.equal((await run(['install', '--profile', 'dsbot'], fx.env)).code, 0);
    assert.equal((await run(['install', '--profile', 'web'], fx.env)).code, 0);

    const instances = Object.keys(settingsJson(fx).providerInstances).sort();
    assert.deepEqual(instances, ['claude-1', 'dsh-dsbot', 'dsh-foo', 'dsh-web']);
  });

  test('a second install of the same profile is a no-op: no write, no second backup', async () => {
    const fx = fixture();
    assert.equal((await run(['install', '--profile', 'web'], fx.env)).code, 0);
    const firstSettings = readFileSync(fx.settingsPath, 'utf8');
    const firstVariant = readFileSync(join(fx.profiles, 'web-acp', 'package.json'), 'utf8');
    const firstOverlay = readFileSync(overlayOf(fx), 'utf8');

    const second = await run(['install', '--profile', 'web'], fx.env);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /variant web-acp: unchanged/);
    assert.match(second.stdout, /overlay .*: unchanged/);
    assert.match(second.stdout, /unchanged dsh-web/);
    assert.equal(readFileSync(fx.settingsPath, 'utf8'), firstSettings);
    assert.equal(readFileSync(join(fx.profiles, 'web-acp', 'package.json'), 'utf8'), firstVariant);
    assert.equal(readFileSync(overlayOf(fx), 'utf8'), firstOverlay);
    assert.equal(backups(fx).length, 1, 'no backup for a no-op write');
  });

  test('--all installs every non-variant profile except the shipped acp', async () => {
    const fx = fixture();
    const result = await run(['install', '--all'], fx.env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      Object.keys(settingsJson(fx).providerInstances).sort(),
      ['claude-1', 'dsh-dsbot', 'dsh-foo', 'dsh-web'],
    );
    assert.equal(existsSync(join(fx.profiles, 'web-acp')), true);
    assert.equal(existsSync(join(fx.profiles, 'dsbot-acp')), true);
    assert.equal(existsSync(join(fx.profiles, 'acp-acp')), false, 'the shipped acp profile has no variant');
    assert.equal(result.stdout.includes('acp-acp'), false);
  });

  test('without --profile or --all it refuses and says what to pass', async () => {
    const fx = fixture();
    const result = await run(['install'], fx.env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--profile .* or --all|--profile/);
    assert.equal(existsSync(join(fx.profiles, 'web-acp')), false);
  });

  test('a variant directory that is not ours is refused, exit 1', async () => {
    const fx = fixture();
    writeFile(join(fx.profiles, 'web-acp', 'package.json'), '{}\n');
    const before = readFileSync(fx.settingsPath, 'utf8');

    const result = await run(['install', '--profile', 'web'], fx.env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /variant web: refused: .*without the \.t3code-bridge-dsh marker|refuse/);
    assert.equal(readFileSync(join(fx.profiles, 'web-acp', 'package.json'), 'utf8'), '{}\n');
    assert.equal(readFileSync(fx.settingsPath, 'utf8'), before, 'a refused variant gets no instance');
  });
});

describe('uninstall', () => {
  test('removes the variant and its instance only, and leaves a foreign dsh-foo alone', async () => {
    const fx = fixture();
    assert.equal((await run(['install', '--profile', 'web'], fx.env)).code, 0);

    const result = await run(['uninstall', '--profile', 'web'], fx.env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /variant web-acp: removed/);
    assert.match(result.stdout, /removed dsh-web/);

    const after = settingsJson(fx);
    assert.equal(after.providerInstances['dsh-web'], undefined, 'the owned instance is gone');
    assert.equal(after.providerInstances['dsh-foo'].displayName, 'Mine', 'a foreign instance survives');
    assert.deepEqual(after.providerInstances['claude-1'], { driver: 'claudeAgent', displayName: 'Claude' });
    assert.equal(after.theme, 'dark');
    assert.equal(existsSync(join(fx.profiles, 'web-acp')), false);
    assert.equal(existsSync(join(fx.profiles, 'web')), true, 'the source profile is untouched');
    assert.equal(existsSync(overlayOf(fx)), true, 'the overlay stays unless --all clears the last instance');

    // a second uninstall is not an error, it just finds nothing
    const second = await run(['uninstall', '--profile', 'web'], fx.env);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /variant web-acp: absent/);
    assert.match(second.stdout, /no owned instance/);
  });

  test('--all removes every owned instance and then the overlay, keeping foreign ones', async () => {
    const fx = fixture();
    assert.equal((await run(['install', '--all'], fx.env)).code, 0);
    const dry = await run(['uninstall', '--all', '--dry-run'], fx.env);
    assert.equal(dry.code, 0);
    assert.match(dry.stdout, /DRY-RUN: nothing was written/);
    assert.equal(existsSync(join(fx.profiles, 'web-acp')), true, 'dry run removes nothing');
    assert.equal(settingsJson(fx).providerInstances['dsh-web'] !== undefined, true);

    const result = await run(['uninstall', '--all'], fx.env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(Object.keys(settingsJson(fx).providerInstances).sort(), ['claude-1', 'dsh-foo']);
    assert.equal(existsSync(join(fx.profiles, 'web-acp')), false);
    assert.equal(existsSync(join(fx.profiles, 'dsbot-acp')), false);
    assert.equal(existsSync(overlayOf(fx)), false, 'the overlay goes once no owned instance is left');
  });

  test('never touches an instance it does not own, even when asked for that profile', async () => {
    const fx = fixture();
    const result = await run(['uninstall', '--profile', 'foo'], fx.env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(settingsJson(fx).providerInstances['dsh-foo'].displayName, 'Mine');
  });
});

describe('sync', () => {
  test('reports which variants changed and is a no-op the second time', async () => {
    const fx = fixture();
    assert.equal((await run(['install', '--profile', 'web'], fx.env)).code, 0);

    const clean = await run(['sync', '--dry-run'], fx.env);
    assert.equal(clean.code, 0, clean.stderr);
    assert.match(clean.stdout, /variant web-acp: unchanged/);
    assert.match(clean.stdout, /SUMMARY variants=1 changed=0 failed=0/);

    // the source profile gains a plugin bundle: the variant must follow
    const sourceFile = join(fx.profiles, 'web', 'package.json');
    const source = JSON.parse(readFileSync(sourceFile, 'utf8'));
    source.dsh.profile.bundles.push('@deepseek-ai/dsh-bulk-read');
    writeFileSync(sourceFile, `${JSON.stringify(source, null, 2)}\n`);

    const changed = await run(['sync'], fx.env);
    assert.equal(changed.code, 0, changed.stderr);
    assert.match(changed.stdout, /variant web-acp: updated/);
    assert.match(changed.stdout, /SUMMARY variants=1 changed=1 failed=0/);
    const variant = JSON.parse(readFileSync(join(fx.profiles, 'web-acp', 'package.json'), 'utf8'));
    assert.ok(variant.dsh.profile.bundles.includes('@deepseek-ai/dsh-bulk-read'));

    const again = await run(['sync'], fx.env);
    assert.match(again.stdout, /changed=0/);
  });
});

describe('doctor', () => {
  test('every check passes for a healthy install, and no key value is printed', async () => {
    const fx = fixture();
    assert.equal((await run(['install', '--profile', 'web'], fx.env)).code, 0);

    const result = await run(['doctor', '--profile', 'web'], fx.env);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^PASS  dsh: 0\.2\.2-rc\.1/m);
    assert.match(result.stdout, /^PASS  DSH_HOME:/m);
    assert.match(result.stdout, /^PASS  t3 settings:/m);
    assert.match(result.stdout, /^PASS  variant web-acp:/m);
    assert.match(result.stdout, /^PASS  instance dsh-web:/m);
    assert.match(result.stdout, /^PASS  acp dsh-web: deepseek-harness-acp/m);
    assert.match(result.stdout, /^PASS  keys: OPEN_DESIGN_API_KEY resolved$/m);
    assert.match(result.stdout, /^SUMMARY pass=\d+ fail=0$/m);
    assert.match(result.stdout, /OPEN_DESIGN_API_KEY set dsh\.env len=\d+/, 'key names and states are reported');
    // the two backup providers have no key here; that is shown but is not a failure
    assert.match(result.stdout, /OPENCODE_GO_API_KEY unset/);
    for (const value of Object.values(FAKE)) {
      assert.equal(result.stdout.includes(value), false, 'a key value reached stdout');
      assert.equal(result.stderr.includes(value), false, 'a key value reached stderr');
    }
  });

  test('a missing variant is a FAIL and the exit code is 1', async () => {
    const fx = fixture();
    assert.equal((await run(['install', '--profile', 'web'], fx.env)).code, 0);
    rmSync(join(fx.profiles, 'web-acp'), { recursive: true, force: true });

    const result = await run(['doctor', '--profile', 'web'], fx.env);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^FAIL  variant web-acp: missing$/m);
    assert.match(result.stdout, /^SUMMARY pass=\d+ fail=\d+$/m);
  });

  test('no key at all for the default route is a FAIL, a missing backup key is not', async () => {
    const fx = fixture();
    assert.equal((await run(['install', '--profile', 'web'], fx.env)).code, 0);
    writeFile(join(fx.dshHome, '.env'), `COMMAND_CODE_API_KEY=${FAKE.commandCode}\n`);

    const result = await run(['doctor', '--profile', 'web'], fx.env);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^FAIL  keys: unset: OPEN_DESIGN_API_KEY$/m);
  });

  test('a broken ACP handshake is a FAIL that reports the reason', async () => {
    const fx = fixture();
    assert.equal((await run(['install', '--profile', 'web'], fx.env)).code, 0);

    const result = await run(['doctor', '--profile', 'web'], { ...fx.env, FAKE_DSH_EXIT: '3' });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^FAIL  acp dsh-web: .*exited before answering/m);
    assert.match(result.stdout, /^SUMMARY pass=\d+ fail=1$/m);
  });

  test('without a profile it checks every installed variant; an empty install is a valid run', async () => {
    const fx = fixture();
    const none = await run(['doctor'], fx.env);
    assert.equal(none.code, 0, none.stdout);
    assert.equal(/variant /.test(none.stdout), false, 'nothing installed, nothing to check');
    assert.match(none.stdout, /^SUMMARY pass=\d+ fail=0$/m);

    assert.equal((await run(['install', '--profile', 'web'], fx.env)).code, 0);
    assert.equal((await run(['install', '--profile', 'dsbot'], fx.env)).code, 0);
    const both = await run(['doctor'], fx.env);
    assert.equal(both.code, 0, both.stdout);
    assert.match(both.stdout, /^PASS  variant web-acp:/m);
    assert.match(both.stdout, /^PASS  variant dsbot-acp:/m);
  });
});

describe('launch', () => {
  test('passes the ACP stream to dsh and returns its exit code, printing nothing itself', async () => {
    const fx = fixture();
    const result = await run(['launch', 'web'], { ...fx.env, FAKE_DSH_EXIT: '7' });
    assert.equal(result.code, 7);
    assert.equal(result.stdout, '', 'the launcher writes nothing to stdout');
  });

  test('a bad profile name fails with a reason and no stack trace', async () => {
    const fx = fixture();
    const result = await run(['launch', 'Web'], fx.env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid dsh profile name/);
    assert.equal(result.stdout, '');
  });

  test('resolveKeys reaches the child: the fake dsh sees the resolved env var names', async () => {
    const fx = fixture();
    const log = join(fx.root, 'spawn.log');
    const result = await run(['launch', 'web', '--verbose'], { ...fx.env, FAKE_DSH_EXIT: '0', FAKE_DSH_LOG: log });
    assert.equal(result.code, 0);
    assert.match(result.stderr, /OPEN_DESIGN_API_KEY set dsh\.env len=\d+/, 'diagnostics go to stderr');
    assert.match(readFileSync(log, 'utf8'), /"--profile","web-acp"/);
    assert.match(readFileSync(log, 'utf8'), /"--patch"/);
    for (const value of Object.values(FAKE)) assert.equal(result.stderr.includes(value), false);
  });
});

describe('usage', () => {
  test('--version prints the package version', async () => {
    const result = await run(['--version'], {});
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), '0.0.1');
  });

  test('--help prints the usage block', async () => {
    const result = await run(['--help'], {});
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^usage:/m);
    assert.match(result.stdout, /install \(--profile/);
  });

  test('an unknown command or flag is exit 2 with usage on stderr', async () => {
    const fx = fixture();
    const unknownCommand = await run(['wat'], fx.env);
    assert.equal(unknownCommand.code, 2);
    assert.match(unknownCommand.stderr, /unknown command: wat/);
    assert.match(unknownCommand.stderr, /^usage:/m);
    assert.equal(unknownCommand.stdout, '');

    const unknownFlag = await run(['profiles', '--force'], fx.env);
    assert.equal(unknownFlag.code, 2);
    assert.match(unknownFlag.stderr, /unknown flag: --force/);
    assert.match(unknownFlag.stderr, /^usage:/m);

    const wrongFlag = await run(['profiles', '--all'], fx.env);
    assert.equal(wrongFlag.code, 2);
    assert.match(wrongFlag.stderr, /profiles does not take --all/);

    const extraArg = await run(['profiles', 'web'], fx.env);
    assert.equal(extraArg.code, 2);
    assert.match(extraArg.stderr, /profiles takes no arguments/);

    const noCommand = await run([], fx.env);
    assert.equal(noCommand.code, 2);
    assert.match(noCommand.stderr, /a command is required/);
  });

  test('the instance id and profile names line up with the module that writes them', () => {
    assert.equal(instanceId('web'), 'dsh-web');
    assert.equal(variantName('web'), 'web-acp');
  });
});

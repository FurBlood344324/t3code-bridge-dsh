// Tests for Module C, part 2: key resolution and the masked report.
// Every value here is fake. The real auth files are never read: paths are always inside a temp dir.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";

import {
  KEY_NAMES,
  SOURCES,
  defaultDshHome,
  defaultPaths,
  maskReport,
  missingKeys,
  parseDotEnv,
  resolveKeys,
} from "../src/secrets.js";
import { renderOverlay } from "../src/routes.js";

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const FAKE = {
  envKey: "fake-env-value-AAAAAAAA",
  dotenvKey: "fake-dotenv-value-BBBBBBBB",
  piKey: "fake-pi-value-CCCCCCCC",
  opencodeKey: "fake-opencode-value-DDDDDDDD",
};

function tempDir(prefix = "bridge-secrets-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** A temp layout: dsh home, pi auth, opencode auth — each written only when given. */
function layout({ dotenv, piAuth, opencodeAuth } = {}, prefix) {
  const root = tempDir(prefix);
  const dshHome = join(root, "dsh");
  const piAuthPath = join(root, "pi", "auth.json");
  const opencodeAuthPath = join(root, "opencode", "auth.json");
  mkdirSync(dshHome, { recursive: true });
  if (dotenv !== undefined) writeFile(join(dshHome, ".env"), dotenv);
  if (piAuth !== undefined) writeFile(piAuthPath, typeof piAuth === "string" ? piAuth : JSON.stringify(piAuth));
  if (opencodeAuth !== undefined) {
    writeFile(opencodeAuthPath, typeof opencodeAuth === "string" ? opencodeAuth : JSON.stringify(opencodeAuth));
  }
  return { root, dshHome, piAuthPath, opencodeAuthPath };
}

function row(report, name) {
  const found = report.find((entry) => entry.name === name);
  assert.ok(found, `report has a row for ${name}`);
  return found;
}

function resolve(paths, env = {}) {
  return resolveKeys({ env, ...paths });
}

describe("SOURCES", () => {
  test("covers exactly the three keys the overlay references", () => {
    assert.deepEqual(KEY_NAMES, ["OPEN_DESIGN_API_KEY", "COMMAND_CODE_API_KEY", "OPENCODE_GO_API_KEY"]);
    const overlay = renderOverlay();
    for (const name of KEY_NAMES) assert.match(overlay, new RegExp(`apiKeyEnv: ${name}\\b`));
    for (const entry of SOURCES) {
      assert.equal(entry.chain[0].source, "env", "the process env is consulted first");
      assert.deepEqual(
        entry.chain.map((step) => step.source),
        ["env", "dsh.env", entry.name === "OPENCODE_GO_API_KEY" ? "opencode-auth" : "pi-auth"],
      );
    }
  });
});

describe("resolveKeys precedence", () => {
  test("process env wins over every file", () => {
    const paths = layout({
      dotenv: `OPEN_DESIGN_API_KEY=${FAKE.dotenvKey}\n`,
      piAuth: { opendesign: { key: FAKE.piKey } },
      opencodeAuth: { "opencode-go": { key: FAKE.opencodeKey } },
    });
    const env = { OPEN_DESIGN_API_KEY: FAKE.envKey, COMMAND_CODE_API_KEY: FAKE.envKey };
    const { env: resolved, report } = resolve(paths, env);
    assert.equal(resolved.OPEN_DESIGN_API_KEY, FAKE.envKey);
    assert.equal(resolved.COMMAND_CODE_API_KEY, FAKE.envKey);
    assert.deepEqual(row(report, "OPEN_DESIGN_API_KEY"), {
      name: "OPEN_DESIGN_API_KEY",
      state: "set",
      source: "env",
      length: FAKE.envKey.length,
    });
  });

  test("dsh .env wins over the auth files", () => {
    const paths = layout({
      dotenv: `OPEN_DESIGN_API_KEY=${FAKE.dotenvKey}\nCOMMAND_CODE_API_KEY="${FAKE.dotenvKey}"\n`,
      piAuth: { opendesign: { key: FAKE.piKey }, "command-code": { key: FAKE.piKey } },
    });
    const { env: resolved, report } = resolve(paths);
    assert.equal(resolved.OPEN_DESIGN_API_KEY, FAKE.dotenvKey);
    assert.equal(resolved.COMMAND_CODE_API_KEY, FAKE.dotenvKey, "surrounding quotes are stripped");
    assert.equal(row(report, "OPEN_DESIGN_API_KEY").source, "dsh.env");
  });

  test("pi auth fills what .env lacks; a blank env value does not shadow it", () => {
    const paths = layout({
      dotenv: "OPEN_DESIGN_API_KEY=\n",
      piAuth: { opendesign: { key: FAKE.piKey }, "command-code": { key: FAKE.piKey } },
      opencodeAuth: { "opencode-go": { key: FAKE.opencodeKey } },
    });
    const { env: resolved, report } = resolve(paths, { OPEN_DESIGN_API_KEY: "   " });
    assert.equal(resolved.OPEN_DESIGN_API_KEY, FAKE.piKey);
    assert.equal(resolved.COMMAND_CODE_API_KEY, FAKE.piKey);
    assert.equal(resolved.OPENCODE_GO_API_KEY, FAKE.opencodeKey);
    assert.equal(row(report, "OPEN_DESIGN_API_KEY").source, "pi-auth");
    assert.equal(row(report, "OPENCODE_GO_API_KEY").source, "opencode-auth");
  });

  test("nothing anywhere means unset, not an error", () => {
    const paths = layout({});
    const { env: resolved, report } = resolve(paths);
    assert.deepEqual(resolved, {});
    assert.deepEqual(report, KEY_NAMES.map((name) => ({ name, state: "unset", source: null, length: 0 })));
    assert.deepEqual(missingKeys(report), KEY_NAMES);
  });
});

describe("file tolerance", () => {
  test(".env handles comments, export, spaces, quotes and later-wins", () => {
    const text = [
      "# a comment",
      "   # indented comment",
      "OPEN_DESIGN_API_KEY='single-quoted'",
      "COMMAND_CODE_API_KEY = spaced-value   # trailing comment",
      "export OPENCODE_GO_API_KEY=exported",
      "OPENCODE_GO_API_KEY=last-wins",
      "not a key value line",
      "=no-name",
      "OPEN-DASH=bad-name",
      "",
    ].join("\n");
    const values = parseDotEnv(text);
    assert.equal(values.get("OPEN_DESIGN_API_KEY"), "single-quoted");
    assert.equal(values.get("COMMAND_CODE_API_KEY"), "spaced-value");
    assert.equal(values.get("OPENCODE_GO_API_KEY"), "last-wins");
    assert.equal(values.has("OPEN-DASH"), false);
    assert.equal(values.size, 3);
    assert.equal(parseDotEnv('A="line\\nnext"').get("A"), "line\nnext");
    assert.equal(parseDotEnv(null).size, 0);
  });

  test("broken JSON, missing files and wrong shapes are skipped, never fatal", () => {
    const paths = layout({
      dotenv: "not=parseable-as-anything\n",
      piAuth: "{ this is not json",
      opencodeAuth: { "opencode-go": { type: "api" } },
    });
    const { env: resolved, report } = resolve(paths);
    assert.deepEqual(resolved, {});
    assert.equal(report.length, 3);
    assert.ok(report.every((entry) => entry.state === "unset"));
    // An array at the top level is not an auth file either.
    const second = layout({ piAuth: "[1,2,3]" });
    assert.deepEqual(resolve(second).env, {});
  });

  test("a provider entry may be a bare string or use apiKey/token/accessToken", () => {
    const shapes = [
      { opendesign: FAKE.piKey },
      { opendesign: { apiKey: FAKE.piKey } },
      { opendesign: { token: FAKE.piKey } },
      { opendesign: { accessToken: FAKE.piKey } },
      { opendesign: { type: "api", key: FAKE.piKey } },
    ];
    for (const piAuth of shapes) {
      const paths = layout({ piAuth });
      assert.equal(resolve(paths).env.OPEN_DESIGN_API_KEY, FAKE.piKey, JSON.stringify(piAuth));
    }
  });

  test("a lookup never crosses providers", () => {
    const paths = layout({
      piAuth: { "command-code": { key: FAKE.piKey } },
      opencodeAuth: { opendesign: { key: FAKE.opencodeKey } },
    });
    const { report } = resolve(paths);
    assert.equal(row(report, "COMMAND_CODE_API_KEY").source, "pi-auth");
    assert.equal(row(report, "OPEN_DESIGN_API_KEY").state, "unset");
    assert.equal(row(report, "OPENCODE_GO_API_KEY").state, "unset");
  });
});

describe("maskReport", () => {
  test("prints name, state, source and length — never a value", () => {
    const paths = layout({
      dotenv: `OPEN_DESIGN_API_KEY=${FAKE.dotenvKey}\n`,
      piAuth: { "command-code": { key: FAKE.piKey } },
      opencodeAuth: { "opencode-go": { key: FAKE.opencodeKey } },
    });
    const { report } = resolve(paths);
    const lines = maskReport(report);
    assert.deepEqual(lines, [
      `OPEN_DESIGN_API_KEY set dsh.env len=${FAKE.dotenvKey.length}`,
      `COMMAND_CODE_API_KEY set pi-auth len=${FAKE.piKey.length}`,
      `OPENCODE_GO_API_KEY set opencode-auth len=${FAKE.opencodeKey.length}`,
    ]);
    const joined = lines.join("\n");
    for (const value of Object.values(FAKE)) assert.equal(joined.includes(value), false);
    assert.deepEqual(maskReport([{ name: "X", state: "unset", source: null, length: 0 }]), ["X unset"]);
    assert.deepEqual(maskReport([]), []);
    assert.deepEqual(maskReport(undefined), []);
  });

  test("a fake key never appears in the report, the mask, the overlay or an error", () => {
    const paths = layout({
      dotenv: `OPEN_DESIGN_API_KEY=${FAKE.dotenvKey}\n`,
      piAuth: { "command-code": { key: FAKE.piKey } },
      opencodeAuth: { "opencode-go": { key: FAKE.opencodeKey } },
    });
    const { env: resolved, report } = resolve(paths);
    const surfaces = {
      report: JSON.stringify(report),
      mask: maskReport(report).join("\n"),
      overlay: renderOverlay(),
    };
    for (const value of Object.values(FAKE)) {
      for (const [name, surface] of Object.entries(surfaces)) {
        assert.equal(surface.includes(value), false, `a fake key leaked into the ${name}`);
      }
    }
    assert.equal(JSON.stringify(resolved).includes(FAKE.piKey), true, "only the spawn env carries values");
  });
});

describe("paths", () => {
  test("defaultDshHome honours DSH_HOME, defaultPaths mirrors it under HOME", () => {
    assert.equal(defaultDshHome({ DSH_HOME: "/tmp/dsh-home" }), "/tmp/dsh-home");
    assert.equal(defaultDshHome({ HOME: "/home/u" }), "/home/u/.dsh");
    assert.deepEqual(defaultPaths({ HOME: "/home/u", DSH_HOME: "/tmp/dsh-home" }), {
      dshHome: "/tmp/dsh-home",
      piAuthPath: "/home/u/.pi/agent/auth.json",
      opencodeAuthPath: "/home/u/.local/share/opencode/auth.json",
    });
  });

  test("a relative DSH_HOME is resolved, and defaults follow the passed env", () => {
    assert.equal(defaultDshHome({ DSH_HOME: "relative/dsh" }), join(process.cwd(), "relative", "dsh"));
    const paths = layout({ dotenv: `OPEN_DESIGN_API_KEY=${FAKE.dotenvKey}\n` });
    const { env: resolved } = resolveKeys({ env: { DSH_HOME: paths.dshHome }, dshHome: undefined });
    assert.equal(resolved.OPEN_DESIGN_API_KEY, FAKE.dotenvKey, "the env's DSH_HOME is used when none is passed");
  });
});

// --- review fixes (review-C findings 1-3, 5) ---
import { test as t2 } from "node:test";
import assert2 from "node:assert/strict";
import { parseDotEnv as parseEnv2 } from "../src/secrets.js";
import { overlayPath as overlayPath2 } from "../src/routes.js";

t2("dotenv: quoted value followed by a comment keeps only the quoted text", () => {
  assert2.equal(parseEnv2('A="abc" # prod\nB=\'x y\' # c\n').get("A"), "abc");
  assert2.equal(parseEnv2('B=\'x y\' # c\n').get("B"), "x y");
});

t2("dotenv: escapes are expanded in one pass (\\\\n stays backslash + n)", () => {
  assert2.equal(parseEnv2('A="a\\\\nb"\n').get("A"), "a\\nb");
  assert2.equal(parseEnv2('A="a\\nb"\n').get("A"), "a\nb");
});

t2("dotenv: unterminated quote falls back to the literal text", () => {
  assert2.equal(parseEnv2('A="abc\n').get("A"), '"abc');
});

t2("overlayPath ignores a relative XDG_CONFIG_HOME", () => {
  const p = overlayPath2({ XDG_CONFIG_HOME: "cfg", HOME: "/home/x" });
  assert2.equal(p, "/home/x/.config/t3code-bridge-dsh/routes.yml");
});

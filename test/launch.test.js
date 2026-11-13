// Tests for Module C, part 3: the launcher's pure plan and the real spawn path.
// The child is a fake `dsh` shell script written by the test, so nothing here talks to a model.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { acpProfileName, buildLaunch, findDsh, launch } from "../src/launch.js";
import { renderOverlay } from "../src/routes.js";

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const FAKE = {
  opendesign: "fake-opendesign-key-111111",
  commandCode: "fake-commandcode-key-2222",
  opencode: "fake-opencode-key-33333",
};

function tempDir(prefix = "bridge-launch-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeFile(path, text, mode) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  if (mode) chmodSync(path, mode);
  return path;
}

/** Temp key sources + a fake dsh. All values are fake. */
function fixture({ dshScript = "#!/bin/sh\nexit 0\n" } = {}) {
  const root = tempDir();
  const dshHome = join(root, "dsh");
  mkdirSync(dshHome, { recursive: true });
  writeFile(join(dshHome, ".env"), `OPEN_DESIGN_API_KEY=${FAKE.opendesign}\nCOMMAND_CODE_API_KEY=${FAKE.commandCode}\n`);
  const opencodeAuthPath = writeFile(
    join(root, ".local", "share", "opencode", "auth.json"),
    JSON.stringify({ "opencode-go": { key: FAKE.opencode } }),
  );
  const bin = join(root, "bin");
  const dshPath = writeFile(join(bin, "dsh"), dshScript, 0o755);
  const overlay = join(root, "config", "routes.yml");
  return { root, dshHome, bin, dshPath, overlay, opencodeAuthPath };
}

function baseEnv(fx, extra = {}) {
  return { HOME: fx.root, PATH: `${fx.bin}:/usr/bin:/bin`, DSH_HOME: fx.dshHome, ...extra };
}

describe("acpProfileName", () => {
  test("appends -acp to a valid profile name", () => {
    assert.equal(acpProfileName("web"), "web-acp");
    assert.equal(acpProfileName("open-design"), "open-design-acp");
    assert.equal(acpProfileName("dsh.tui_2"), "dsh.tui_2-acp");
  });

  test("rejects empty and unsafe names", () => {
    for (const bad of ["Web", "../etc", "-web", ".web", "web acp", "web;rm -rf /", "web/acp"]) {
      assert.throws(() => acpProfileName(bad), /invalid dsh profile name/);
    }
    // A non-string is not a name at all: it fails the "required" check, not the character check.
    for (const empty of ["", "   ", null, undefined, 42]) {
      assert.throws(() => acpProfileName(empty), /a dsh profile name is required/);
    }
  });
});

describe("findDsh", () => {
  test("finds dsh on PATH and prefers an explicit path", () => {
    const fx = fixture();
    assert.equal(findDsh(baseEnv(fx)), fx.dshPath);
    assert.equal(findDsh(baseEnv(fx), { dshPath: "/opt/custom/dsh" }), "/opt/custom/dsh");
    assert.throws(() => findDsh({ PATH: "/nonexistent" }), /dsh was not found on PATH/);
    assert.throws(() => findDsh({}), /dsh was not found on PATH/);
  });

  test("skips a non-executable file with the right name", () => {
    const fx = fixture();
    const plain = join(fx.root, "plain");
    writeFile(join(plain, "dsh"), "not executable\n", 0o644);
    assert.throws(() => findDsh({ PATH: plain }), /not found on PATH/);
  });
});

describe("buildLaunch", () => {
  test("resolves the variant profile, the overlay and the keys", () => {
    const fx = fixture();
    const plan = buildLaunch({ profile: "web", env: baseEnv(fx), overlay: fx.overlay });
    assert.equal(plan.command, fx.dshPath);
    assert.deepEqual(plan.args, ["--profile", "web-acp", "--patch", fx.overlay]);
    assert.equal(plan.profile, "web-acp");
    assert.equal(plan.overlay, fx.overlay);
    assert.equal(plan.env.OPEN_DESIGN_API_KEY, FAKE.opendesign);
    assert.equal(plan.env.COMMAND_CODE_API_KEY, FAKE.commandCode);
    assert.equal(plan.env.OPENCODE_GO_API_KEY, FAKE.opencode);
    assert.equal(plan.env.DSH_HOME, fx.dshHome);
    assert.equal(plan.env.PATH, baseEnv(fx).PATH, "the parent environment is passed through");
    assert.deepEqual(
      plan.report.map((row) => [row.name, row.state, row.source, row.length]),
      [
        ["OPEN_DESIGN_API_KEY", "set", "dsh.env", FAKE.opendesign.length],
        ["COMMAND_CODE_API_KEY", "set", "dsh.env", FAKE.commandCode.length],
        ["OPENCODE_GO_API_KEY", "set", "opencode-auth", FAKE.opencode.length],
      ],
    );
  });

  test("the overlay path defaults to the XDG config location", () => {
    const fx = fixture();
    const plan = buildLaunch({ profile: "web", env: baseEnv(fx, { XDG_CONFIG_HOME: join(fx.root, "xdg") }) });
    assert.equal(plan.overlay, join(fx.root, "xdg", "t3code-bridge-dsh", "routes.yml"));
    assert.equal(plan.env.XDG_CONFIG_HOME, join(fx.root, "xdg"));
  });

  test("an explicit dshPath wins and nothing is written", () => {
    const fx = fixture();
    const plan = buildLaunch({ profile: "web", dshPath: "/opt/dsh", env: baseEnv(fx), overlay: fx.overlay });
    assert.equal(plan.command, "/opt/dsh");
    assert.equal(existsSync(fx.overlay), false, "buildLaunch writes nothing");
  });

  test("a bad profile throws before anything is resolved", () => {
    const fx = fixture();
    assert.throws(() => buildLaunch({ profile: "web; rm -rf", env: baseEnv(fx) }), /invalid dsh profile name/);
  });

  test("the process env is the first source; a blank value does not win", () => {
    const fx = fixture();
    const env = baseEnv(fx, { OPEN_DESIGN_API_KEY: "", COMMAND_CODE_API_KEY: "from-the-parent" });
    const plan = buildLaunch({ profile: "web", env, overlay: fx.overlay });
    assert.equal(plan.env.OPEN_DESIGN_API_KEY, FAKE.opendesign, "a blank parent value is skipped");
    assert.equal(plan.env.COMMAND_CODE_API_KEY, "from-the-parent", "a set parent value outranks .env");
    assert.deepEqual(
      plan.report
        .filter((row) => row.name !== "OPENCODE_GO_API_KEY")
        .map((row) => [row.name, row.source]),
      [
        ["OPEN_DESIGN_API_KEY", "dsh.env"],
        ["COMMAND_CODE_API_KEY", "env"],
      ],
    );
  });

  test("a thrown error names the problem, never a key value", async () => {
    const fx = fixture();
    const messages = [];
    // Every error a caller can realistically hit, with the keys already resolved in each case.
    try {
      buildLaunch({ profile: `bad ${FAKE.opendesign}`, env: baseEnv(fx) });
    } catch (err) {
      messages.push(`${err && err.message}`);
    }
    try {
      buildLaunch({ profile: "web", env: { HOME: fx.root, PATH: "/nonexistent" }, overlay: fx.overlay });
    } catch (err) {
      messages.push(`${err && err.message}`);
    }
    await launch({ profile: "web", env: baseEnv(fx), overlay: fx.overlay, stdio: "ignore", routes: { providers: {} } }).then(
      () => assert.fail("a broken route table must reject"),
      (err) => messages.push(`${err && err.message}`),
    );
    assert.equal(messages.length, 3);
    assert.match(messages[0], /invalid dsh profile name/, "the profile error is the one we expect");
    for (const value of Object.values(FAKE)) {
      for (const message of messages) assert.equal(message.includes(value), false, "a key leaked into an error");
    }
  });

  test("the plan never puts a key value in the report", () => {
    const fx = fixture();
    const plan = buildLaunch({ profile: "web", env: baseEnv(fx), overlay: fx.overlay });
    const text = JSON.stringify(plan.report);
    for (const value of Object.values(FAKE)) assert.equal(text.includes(value), false);
  });
});

describe("launch", () => {
  test("writes the overlay, starts dsh with the variant args and returns the exit code", async () => {
    const fx = fixture({
      dshScript: [
        "#!/bin/sh",
        'printf "%s\\n" "$@" > "$DSH_HOME/args.txt"',
        'printf "%s" "$OPEN_DESIGN_API_KEY" | wc -c > "$DSH_HOME/keylen.txt"',
        "exit 7",
        "",
      ].join("\n"),
    });
    const code = await launch({ profile: "web", env: baseEnv(fx), overlay: fx.overlay, stdio: "ignore" });
    assert.equal(code, 7);
    assert.equal(readFileSync(fx.overlay, "utf8"), renderOverlay(), "the overlay exists and is current");
    assert.equal(
      readFileSync(join(fx.dshHome, "args.txt"), "utf8"),
      ["--profile", "web-acp", "--patch", fx.overlay, ""].join("\n"),
    );
    assert.equal(Number(readFileSync(join(fx.dshHome, "keylen.txt"), "utf8").trim()), FAKE.opendesign.length);
  });

  test("an unchanged overlay is left alone on the second run", async () => {
    const fx = fixture();
    assert.equal(await launch({ profile: "web", env: baseEnv(fx), overlay: fx.overlay, stdio: "ignore" }), 0);
    const first = readFileSync(fx.overlay, "utf8");
    assert.equal(await launch({ profile: "web", env: baseEnv(fx), overlay: fx.overlay, stdio: "ignore" }), 0);
    assert.equal(readFileSync(fx.overlay, "utf8"), first);
  });

  test("SIGTERM is forwarded and the child's own exit code is returned", async () => {
    const fx = fixture({
      dshScript: [
        "#!/bin/sh",
        "trap 'exit 42' TERM",
        'echo $$ > "$DSH_HOME/child.pid"',
        "while true; do sleep 0.05; done",
        "",
      ].join("\n"),
    });
    const pending = launch({ profile: "web", env: baseEnv(fx), overlay: fx.overlay, stdio: "ignore" });
    const childPid = Number((await waitForFile(join(fx.dshHome, "child.pid"))).trim());
    assert.ok(childPid > 0, "the child started");
    assert.doesNotThrow(() => process.kill(childPid, 0), "the child is alive before the signal");
    process.emit("SIGTERM");
    assert.equal(await pending, 42, "the child handled the forwarded signal");
  });

  test("a child killed by a signal maps to 128 + signal number", async () => {
    const fx = fixture({ dshScript: ["#!/bin/sh", "kill -9 $$", "sleep 1", ""].join("\n") });
    const code = await launch({ profile: "web", env: baseEnv(fx), overlay: fx.overlay, stdio: "ignore" });
    assert.equal(code, 137, "SIGKILL is reported as a shell-style exit code");
  });

  test("dry run resolves everything but spawns nothing", async () => {
    const fx = fixture({
      dshScript: ["#!/bin/sh", 'touch "$DSH_HOME/spawned"', "exit 0", ""].join("\n"),
    });
    assert.equal(await launch({ profile: "web", env: baseEnv(fx), overlay: fx.overlay, dryRun: true }), 0);
    assert.equal(existsSync(join(fx.dshHome, "spawned")), false);
    assert.equal(existsSync(fx.overlay), false, "dry run writes nothing");
  });

  test("a route table that fails validation rejects before the overlay or the child exist", async () => {
    const fx = fixture({ dshScript: ["#!/bin/sh", 'touch "$DSH_HOME/spawned"', "exit 0", ""].join("\n") });
    await assert.rejects(
      launch({
        profile: "web",
        env: baseEnv(fx),
        overlay: fx.overlay,
        routes: { providers: {}, default: {} },
        stdio: "ignore",
      }),
      /providers is empty/,
    );
    assert.equal(existsSync(fx.overlay), false, "no overlay was written");
    assert.equal(existsSync(join(fx.dshHome, "spawned")), false, "no child was started");
  });

  test("a missing dsh rejects with a clear error and leaves no process", async () => {
    const fx = fixture();
    await assert.rejects(
      launch({ profile: "web", env: { HOME: fx.root, PATH: "/nonexistent" }, overlay: fx.overlay }),
      /dsh was not found on PATH/,
    );
  });

  test("onSpawn sees the child and a throwing observer does not break the launcher", async () => {
    const fx = fixture({ dshScript: "#!/bin/sh\nexit 3\n" });
    let seen = null;
    const code = await launch({
      profile: "web",
      env: baseEnv(fx),
      overlay: fx.overlay,
      stdio: "ignore",
      onSpawn: (child) => {
        seen = child.pid;
        throw new Error("an observer must not break the launcher");
      },
    });
    assert.equal(code, 3);
    assert.ok(seen > 0);
  });
});

/** Poll until `path` exists with content, then return that content. */
async function waitForFile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = readFileSync(path, "utf8");
      if (text.trim() !== "") return text;
    } catch {
      // not created yet
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

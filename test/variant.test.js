// Tests for Module A: dsh profile discovery and ACP variants.
// Everything happens in a temp DSH_HOME; the real ~/.dsh is never read or written.
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  ACP_BUNDLE,
  APP_BUNDLES,
  BASE_BUNDLE,
  VARIANT_MARKER,
  dshHome,
  listProfiles,
  patchHeader,
} from "../src/profiles.js";
import { applyVariant, planVariant, removeVariant, syncVariant, variantBundles } from "../src/variant.js";

const temps = [];

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** Write `<home>/profiles/<name>/{package.json,cordis.patch.yml}` (+ node_modules when asked). */
function makeProfile(home, name, { bundles, dependencies = {}, patch = "[]\n", cordis = null, modules = false } = {}) {
  const dir = join(home, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: `dsh-profile-${name}`, private: true, dependencies, dsh: { profile: { bundles } } }, null, 2) + "\n",
  );
  if (patch !== null) writeFileSync(join(dir, "cordis.patch.yml"), patch);
  if (cordis !== null) writeFileSync(join(dir, "cordis.yml"), cordis);
  if (modules) mkdirSync(join(dir, "node_modules"), { recursive: true });
  return dir;
}

/** Fresh temp DSH_HOME with a web, a headless and the shipped acp profile plus junk. */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "bridge-dsh-variant-"));
  temps.push(home);
  makeProfile(home, "web", {
    bundles: [BASE_BUNDLE, "@deepseek-ai/dsh-web-app", "dsh-beyin", "dsh-bulk-read", "@wxg-prc-cpg/browser-skill-dsh-plugin"],
    dependencies: { "dsh-beyin": "link:/tmp/does-not-matter", "dsh-bulk-read": "link:/tmp/does-not-matter" },
    patch: "# Your patch layer for this dsh profile\n- id: ui-settings-general\n  name: \"@deepseek-ai/dsh-client-ui-settings-general\"\n",
    cordis: "plugins:\n  - id: core\n",
    modules: true,
  });
  makeProfile(home, "headless", { bundles: [BASE_BUNDLE, "@deepseek-ai/dsh-headless"] });
  makeProfile(home, "acp", { bundles: [BASE_BUNDLE, ACP_BUNDLE] });

  // junk that must be skipped
  mkdirSync(join(home, "profiles", ".hidden"), { recursive: true });
  writeFileSync(join(home, "profiles", ".hidden", "package.json"), JSON.stringify({ dsh: { profile: { bundles: [] } } }));
  const noPkg = join(home, "profiles", "no-package-json");
  mkdirSync(noPkg, { recursive: true });
  writeFileSync(join(noPkg, "package.json"), JSON.stringify({ name: "not-a-profile" }));
  writeFileSync(join(home, "profiles", "stray.txt"), "not a directory\n");
  return home;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("dshHome", () => {
  test("uses DSH_HOME when set and falls back to ~/.dsh", () => {
    assert.equal(dshHome({ DSH_HOME: "/tmp/some-dsh-home" }), "/tmp/some-dsh-home");
    assert.match(dshHome({}), /\.dsh$/);
    assert.ok(dshHome({}).startsWith("/"));
    assert.equal(dshHome({ DSH_HOME: "relative/dir" }), join(process.cwd(), "relative", "dir"));
  });
});

describe("listProfiles", () => {
  test("finds profiles and ignores junk", () => {
    const home = makeHome();
    const profiles = listProfiles({ home });
    assert.deepEqual(
      profiles.map((profile) => profile.name),
      ["acp", "headless", "web"],
    );

    const web = profiles.find((profile) => profile.name === "web");
    assert.equal(web.dir, join(home, "profiles", "web"));
    assert.deepEqual(web.appBundles, ["@deepseek-ai/dsh-web-app"]);
    assert.equal(web.isVariant, false);
    assert.equal(web.variantName, "web-acp");
    assert.equal(web.variantExists, false);
    assert.ok(web.bundles.includes("dsh-beyin"));

    const headless = profiles.find((profile) => profile.name === "headless");
    assert.deepEqual(headless.appBundles, ["@deepseek-ai/dsh-headless"]);
    assert.deepEqual(headless.bundles, [BASE_BUNDLE, "@deepseek-ai/dsh-headless"]);
  });

  test("missing profiles directory yields an empty list", () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-dsh-empty-"));
    temps.push(home);
    assert.deepEqual(listProfiles({ home }), []);
  });

  test("reports a variant only when its directory carries the marker", () => {
    const home = makeHome();
    const plan = planVariant("headless", { home });
    applyVariant(plan);
    const profiles = listProfiles({ home });
    const source = profiles.find((profile) => profile.name === "headless");
    assert.equal(source.variantExists, true);
    const variant = profiles.find((profile) => profile.name === "headless-acp");
    assert.equal(variant.isVariant, true);
    assert.deepEqual(variant.appBundles, []);

    // An unmarked directory of the same name is not claimed by the tool.
    const other = makeHome();
    mkdirSync(join(other, "profiles", "headless-acp"), { recursive: true });
    writeFileSync(join(other, "profiles", "headless-acp", "package.json"), JSON.stringify({ dsh: { profile: { bundles: [] } } }));
    assert.equal(listProfiles({ home: other }).find((p) => p.name === "headless").variantExists, false);
  });
});

describe("variantBundles", () => {
  test("drops every app bundle and puts the ACP app right after base", () => {
    assert.deepEqual(
      variantBundles([BASE_BUNDLE, "@deepseek-ai/dsh-web-app", "dsh-beyin", "dsh-bulk-read"]),
      [BASE_BUNDLE, ACP_BUNDLE, "dsh-beyin", "dsh-bulk-read"],
    );
  });

  test("puts the ACP app first when the base bundle is absent", () => {
    assert.deepEqual(variantBundles(["dsh-beyin"]), [ACP_BUNDLE, "dsh-beyin"]);
  });

  test("honours a custom app bundle list and does not duplicate an existing ACP bundle", () => {
    assert.deepEqual(variantBundles([BASE_BUNDLE, ACP_BUNDLE, "x"], {}), [BASE_BUNDLE, ACP_BUNDLE, "x"]);
    assert.deepEqual(variantBundles([BASE_BUNDLE, "my-app", "plugin"], { appBundles: ["my-app"] }), [
      BASE_BUNDLE,
      ACP_BUNDLE,
      "plugin",
    ]);
  });

  test("does not mutate the source list", () => {
    const source = [BASE_BUNDLE, "@deepseek-ai/dsh-web-app"];
    variantBundles(source);
    assert.deepEqual(source, [BASE_BUNDLE, "@deepseek-ai/dsh-web-app"]);
  });
});

describe("planVariant", () => {
  test("swaps the app bundle and keeps plugin bundles and order", () => {
    const home = makeHome();
    const plan = planVariant("web", { home });
    assert.equal(plan.source, "web");
    assert.equal(plan.target, "web-acp");
    assert.equal(plan.sourceDir, join(home, "profiles", "web"));
    assert.equal(plan.targetDir, join(home, "profiles", "web-acp"));
    assert.equal(plan.packageJson.name, "dsh-profile-web-acp");
    assert.deepEqual(plan.packageJson.dsh.profile.bundles, [
      BASE_BUNDLE,
      ACP_BUNDLE,
      "dsh-beyin",
      "dsh-bulk-read",
      "@wxg-prc-cpg/browser-skill-dsh-plugin",
    ]);
    // dependencies and unrelated keys survive
    assert.deepEqual(plan.packageJson.dependencies, {
      "dsh-beyin": "link:/tmp/does-not-matter",
      "dsh-bulk-read": "link:/tmp/does-not-matter",
    });
    assert.equal(plan.packageJson.private, true);
    // the source package.json is untouched
    assert.deepEqual(readJson(join(home, "profiles", "web", "package.json")).dsh.profile.bundles, [
      BASE_BUNDLE,
      "@deepseek-ai/dsh-web-app",
      "dsh-beyin",
      "dsh-bulk-read",
      "@wxg-prc-cpg/browser-skill-dsh-plugin",
    ]);
    assert.ok(plan.actions.length > 0);
  });

  test("patch header added, source body preserved", () => {
    const home = makeHome();
    const plan = planVariant("web", { home });
    const lines = plan.patchYml.split("\n");
    assert.equal(lines[0], patchHeader("web"));
    assert.match(lines[0], /^# generated by t3code-bridge-dsh from profile web; run `t3code-bridge-dsh sync`$/);
    assert.ok(plan.patchYml.includes("- id: ui-settings-general"));
    assert.ok(plan.patchYml.endsWith("\n"));
    // header is not stacked when a generated patch is used as a source
    const again = planVariant("web", { home });
    assert.equal(again.patchYml.match(/# generated by t3code-bridge-dsh/g).length, 1);
  });

  test("a missing cordis.patch.yml becomes header + empty array", () => {
    const home = makeHome();
    makeProfile(home, "bare", { bundles: [BASE_BUNDLE, "@deepseek-ai/dsh-headless"], patch: null });
    const plan = planVariant("bare", { home });
    assert.equal(plan.patchYml, `${patchHeader("bare")}\n[]\n`);
  });

  test("an empty or whitespace-only cordis.patch.yml also becomes an empty array", () => {
    const home = makeHome();
    makeProfile(home, "blank", { bundles: [BASE_BUNDLE, "@deepseek-ai/dsh-headless"], patch: "\n" });
    assert.equal(planVariant("blank", { home }).patchYml, `${patchHeader("blank")}\n[]\n`);
    makeProfile(home, "blank2", { bundles: [BASE_BUNDLE, "@deepseek-ai/dsh-headless"], patch: "# only a comment\n" });
    assert.equal(planVariant("blank2", { home }).patchYml, `${patchHeader("blank2")}\n# only a comment\n`);
  });

  test("throws for unknown, variant and shipped acp profiles", () => {
    const home = makeHome();
    assert.throws(() => planVariant("nope", { home }), /not found/);
    assert.throws(() => planVariant("acp", { home }), /shipped ACP profile/);
    assert.throws(() => planVariant("", { home }), /non-empty string/);
    applyVariant(planVariant("headless", { home }));
    assert.throws(() => planVariant("headless-acp", { home }), /is itself an ACP variant/);
  });

  test("APP_BUNDLES covers the shipped app bundles", () => {
    for (const bundle of [
      "@deepseek-ai/dsh-web-app",
      "@deepseek-ai/dsh-headless",
      "@deepseek-ai/dsh-sdk-app",
      "@deepseek-ai/dsh-sdk-minimal",
      "ds-bot",
      "@deepseek-harness-tui/dsh-tui",
      "@open-design/dsh-runtime",
    ]) {
      assert.ok(APP_BUNDLES.includes(bundle), bundle);
    }
  });
});

describe("applyVariant", () => {
  test("creates files and the node_modules symlink", () => {
    const home = makeHome();
    const plan = planVariant("web", { home });
    const result = applyVariant(plan);
    assert.deepEqual(result, { created: true, updated: false, dir: plan.targetDir });

    assert.deepEqual(readJson(join(plan.targetDir, "package.json")), plan.packageJson);
    const rawPackage = readFileSync(join(plan.targetDir, "package.json"), "utf8");
    assert.ok(rawPackage.endsWith("}\n"), "package.json ends with a newline");
    assert.ok(rawPackage.includes('\n  "name"'), "package.json is 2-space indented");
    assert.equal(readFileSync(join(plan.targetDir, "cordis.patch.yml"), "utf8").split("\n")[0], patchHeader("web"));
    assert.equal(readFileSync(join(plan.targetDir, "cordis.yml"), "utf8"), "plugins:\n  - id: core\n");

    const marker = readJson(join(plan.targetDir, VARIANT_MARKER));
    assert.equal(marker.source, "web");
    assert.ok(!Number.isNaN(Date.parse(marker.createdAt)));

    const link = join(plan.targetDir, "node_modules");
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), join(home, "profiles", "web", "node_modules"));
  });

  test("apply twice is a no-op", () => {
    const home = makeHome();
    const first = applyVariant(planVariant("web", { home }));
    assert.equal(first.created, true);
    const target = join(home, "profiles", "web-acp");
    const before = readFileSync(join(target, VARIANT_MARKER), "utf8");
    const packageBefore = readFileSync(join(target, "package.json"), "utf8");

    const second = applyVariant(planVariant("web", { home }));
    assert.equal(second.created, false);
    assert.equal(second.updated, false);
    assert.equal(readFileSync(join(target, VARIANT_MARKER), "utf8"), before, "createdAt is stable");
    assert.equal(readFileSync(join(target, "package.json"), "utf8"), packageBefore);
  });

  test("a changed source profile is reported as updated", () => {
    const home = makeHome();
    applyVariant(planVariant("web", { home }));
    makeProfile(home, "web", { bundles: [BASE_BUNDLE, "@deepseek-ai/dsh-web-app", "dsh-beyin", "dsh-extra"], modules: true });
    const result = syncVariant("web", { home });
    assert.deepEqual(result, { created: false, updated: true, dir: join(home, "profiles", "web-acp") });
    assert.deepEqual(readJson(join(home, "profiles", "web-acp", "package.json")).dsh.profile.bundles, [
      BASE_BUNDLE,
      ACP_BUNDLE,
      "dsh-beyin",
      "dsh-extra",
    ]);
  });

  test("a profile without node_modules gets no symlink", () => {
    const home = makeHome();
    const plan = planVariant("headless", { home });
    applyVariant(plan);
    assert.equal(existsSync(join(plan.targetDir, "node_modules")), false);
  });

  test("refuses an unmarked existing dir", () => {
    const home = makeHome();
    const plan = planVariant("web", { home });
    mkdirSync(plan.targetDir, { recursive: true });
    writeFileSync(join(plan.targetDir, "user-file.txt"), "mine\n");
    assert.throws(() => applyVariant(plan), /refusing to overwrite/);
    assert.equal(readFileSync(join(plan.targetDir, "user-file.txt"), "utf8"), "mine\n");
    assert.equal(existsSync(join(plan.targetDir, "package.json")), false);
  });

  test("dry run writes nothing", () => {
    const home = makeHome();
    const plan = planVariant("web", { home });
    const result = applyVariant(plan, { dryRun: true });
    assert.deepEqual(result, { created: true, updated: false, dir: plan.targetDir });
    assert.equal(existsSync(plan.targetDir), false);

    applyVariant(plan);
    const snapshot = readFileSync(join(plan.targetDir, "package.json"), "utf8");
    makeProfile(home, "web", { bundles: [BASE_BUNDLE, "@deepseek-ai/dsh-web-app", "dsh-beyin", "dsh-extra"], modules: true });
    const dry = applyVariant(planVariant("web", { home }), { dryRun: true });
    assert.deepEqual(dry, { created: false, updated: true, dir: plan.targetDir });
    assert.equal(readFileSync(join(plan.targetDir, "package.json"), "utf8"), snapshot);
  });

  test("rejects a plan it did not get from planVariant", () => {
    assert.throws(() => applyVariant({}), /expected a plan/);
  });

  test("refuses to write through a symlinked target dir", () => {
    const home = makeHome();
    const plan = planVariant("headless", { home });
    const elsewhere = mkdtempSync(join(tmpdir(), "bridge-dsh-real-"));
    temps.push(elsewhere);
    symlinkSync(elsewhere, plan.targetDir, "dir");
    assert.throws(() => applyVariant(plan), /through the symlink/);
    assert.deepEqual(readdirSync(elsewhere), [], "the symlink target is untouched");
  });
});

describe("removeVariant", () => {
  test("only removes marked dirs and leaves the source and its node_modules untouched", () => {
    const home = makeHome();
    const plan = planVariant("web", { home });
    applyVariant(plan);
    const modulesMarker = join(home, "profiles", "web", "node_modules", "keep.txt");
    writeFileSync(modulesMarker, "x\n");

    assert.deepEqual(removeVariant("web", { home }), { removed: true });
    assert.equal(existsSync(plan.targetDir), false);
    assert.equal(existsSync(join(home, "profiles", "web", "package.json")), true);
    assert.equal(existsSync(modulesMarker), true, "source node_modules is not followed or deleted");
  });

  test("refuses an unmarked dir and an absent variant", () => {
    const home = makeHome();
    mkdirSync(join(home, "profiles", "web-acp"), { recursive: true });
    writeFileSync(join(home, "profiles", "web-acp", "package.json"), "{}\n");
    assert.deepEqual(removeVariant("web", { home }), { removed: false });
    assert.equal(existsSync(join(home, "profiles", "web-acp", "package.json")), true);

    assert.deepEqual(removeVariant("headless", { home }), { removed: false });
    assert.throws(() => removeVariant("", { home }), /non-empty string/);
  });

  test("dry run removes nothing", () => {
    const home = makeHome();
    const plan = planVariant("headless", { home });
    applyVariant(plan);
    assert.deepEqual(removeVariant("headless", { home, dryRun: true }), { removed: true });
    assert.equal(existsSync(plan.targetDir), true);
  });

  test("a symlinked variant dir is unlinked, never followed", () => {
    const home = makeHome();
    const real = mkdtempSync(join(tmpdir(), "bridge-dsh-behind-"));
    temps.push(real);
    writeFileSync(join(real, VARIANT_MARKER), JSON.stringify({ source: "web", createdAt: "2026-01-01T00:00:00.000Z" }));
    writeFileSync(join(real, "keep.txt"), "x\n");
    symlinkSync(real, join(home, "profiles", "web-acp"), "dir");

    assert.deepEqual(removeVariant("web", { home }), { removed: true });
    assert.equal(existsSync(join(home, "profiles", "web-acp")), false);
    assert.equal(existsSync(join(real, "keep.txt")), true, "the real dir behind the link survives");
  });
});

describe("syncVariant", () => {
  test("creates then refreshes the variant", () => {
    const home = makeHome();
    assert.deepEqual(syncVariant("headless", { home }), {
      created: true,
      updated: false,
      dir: join(home, "profiles", "headless-acp"),
    });
    assert.deepEqual(syncVariant("headless", { home }), {
      created: false,
      updated: false,
      dir: join(home, "profiles", "headless-acp"),
    });
  });
});

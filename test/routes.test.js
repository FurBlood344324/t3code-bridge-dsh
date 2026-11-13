// Tests for Module C, part 1: the routes overlay text and its file handling.
// No real dsh, no real keys: the structure is asserted with test/helpers/yaml.js.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  DEFAULT_ROUTES,
  LLM_ENTRY_NAME,
  DEFAULT_MODEL_ENTRY_NAME,
  ROUTES_HEADER,
  overlayPath,
  renderOverlay,
  validateRoutes,
  writeOverlay,
} from "../src/routes.js";
import { parseYaml } from "./helpers/yaml.js";

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "bridge-routes-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function parsed() {
  return parseYaml(renderOverlay());
}

/** `[{id, config}]` from the overlay, keyed by entry id. */
function entries() {
  const { value } = parsed();
  assert.ok(Array.isArray(value), "the overlay is a top-level array");
  const byId = {};
  for (const entry of value) byId[entry.id] = entry;
  return byId;
}

describe("renderOverlay", () => {
  test("starts with the env-var-names-only header and is an array of two entries", () => {
    const text = renderOverlay();
    assert.equal(text.split("\n")[0], ROUTES_HEADER);
    const { value } = parseYaml(text);
    assert.equal(value.length, 2);
    assert.deepEqual(
      value.map((entry) => ({ id: entry.id, name: entry.name })),
      [
        { id: "llm-pi-ai", name: LLM_ENTRY_NAME },
        { id: "agent-default-model", name: DEFAULT_MODEL_ENTRY_NAME },
      ],
    );
  });

  test("the llm-pi-ai entry carries exactly the three providers, in a stable order", () => {
    const providers = entries()["llm-pi-ai"].config.providers;
    assert.deepEqual(Object.keys(providers), ["opendesign", "command-code", "opencode-go"]);
    assert.deepEqual(
      { ...providers.opendesign, models: undefined },
      {
        displayName: "Open Design",
        apiKeyEnv: "OPEN_DESIGN_API_KEY",
        api: "openai-completions",
        baseURL: "https://amr-link.open-design.ai/v1",
        compat: {
          supportsDeveloperRole: false,
          supportsStore: false,
          maxTokensField: "max_tokens",
          requiresReasoningContentOnAssistantMessages: true,
        },
        models: undefined,
      },
    );
    // Only env var names reach the file.
    assert.deepEqual(
      ["opendesign", "command-code", "opencode-go"].map((id) => providers[id].apiKeyEnv),
      ["OPEN_DESIGN_API_KEY", "COMMAND_CODE_API_KEY", "OPENCODE_GO_API_KEY"],
    );
  });

  test("operator rules: opendesign flash medium/high/max text+image, eco medium only text", () => {
    const models = entries()["llm-pi-ai"].config.providers.opendesign.models;
    const flash = models.find((model) => model.id === "deepseek-v4.1-flash");
    const eco = models.find((model) => model.id === "deepseek-v4.1-flash-eco");
    assert.deepEqual(flash.reasoningEfforts, { medium: "medium", high: "high", max: "max" });
    assert.deepEqual(flash.input, ["text", "image"]);
    assert.deepEqual(eco.reasoningEfforts, { medium: "medium" });
    assert.deepEqual(eco.input, ["text"]);
    assert.equal(models.length, 2);
  });

  test("operator rules: command-code offers high only, opencode-go offers every level", () => {
    const providers = entries()["llm-pi-ai"].config.providers;
    const cc = providers["command-code"].models;
    assert.equal(cc.length, 1);
    assert.equal(cc[0].id, "deepseek/deepseek-v4.1-flash");
    assert.deepEqual(cc[0].reasoningEfforts, { high: "high" });

    const go = providers["opencode-go"].models;
    assert.equal(go.length, 1);
    assert.equal(go[0].id, "deepseek-v4.1-flash");
    assert.deepEqual(go[0].reasoningEfforts, { low: "low", medium: "medium", high: "high", max: "max" });
  });

  test("default model entry is opendesign deepseek-v4.1-flash at max", () => {
    assert.deepEqual(entries()["agent-default-model"].config, {
      provider: "opendesign",
      model: "deepseek-v4.1-flash",
      reasoningEffort: "max",
    });
    assert.deepEqual(DEFAULT_ROUTES.default, {
      provider: "opendesign",
      model: "deepseek-v4.1-flash",
      reasoningEffort: "max",
    });
  });

  test("output is deterministic and DEFAULT_ROUTES is not mutated by rendering", () => {
    const first = renderOverlay();
    const snapshot = JSON.stringify(DEFAULT_ROUTES);
    for (let i = 0; i < 5; i += 1) assert.equal(renderOverlay(), first);
    assert.equal(renderOverlay(structuredClone(DEFAULT_ROUTES)), first);
    assert.equal(JSON.stringify(DEFAULT_ROUTES), snapshot);
  });

  test("a caller-supplied route table is rendered in its own key order", () => {
    const routes = {
      default: { provider: "opencode-go", model: "x", reasoningEffort: "low" },
      providers: {
        "opencode-go": {
          apiKeyEnv: "OPENCODE_GO_API_KEY",
          models: [{ id: "x", reasoningEfforts: { low: "low" } }],
          compat: { supportsStore: false },
        },
      },
    };
    const { value } = parseYaml(renderOverlay(routes));
    assert.deepEqual(Object.keys(value[0].config.providers), ["opencode-go"]);
    assert.deepEqual(value[1].config, { provider: "opencode-go", model: "x", reasoningEffort: "low" });
    assert.deepEqual(value[0].config.providers["opencode-go"].compat, { supportsStore: false });
  });

  test("scalars are quoted only where YAML needs it (matches the dsbot patch style)", () => {
    const text = renderOverlay();
    assert.match(text, /^  name: "@deepseek-ai\/dsh-llm-pi-ai"$/m, "an indicator-starting scalar is quoted");
    assert.match(text, /^        baseURL: https:\/\/amr-link\.open-design\.ai\/v1$/m, "a URL stays plain");
    assert.match(text, /^            name: DS V4\.1 Flash$/m, "a plain name stays plain");
    assert.match(text, /^        apiKeyEnv: OPEN_DESIGN_API_KEY$/m, "a bare env var name stays plain");
  });

  test("a scalar that would change YAML meaning is quoted", () => {
    const routes = {
      default: { provider: "p", model: "m", reasoningEffort: "max" },
      providers: { p: { apiKeyEnv: "P_KEY", displayName: "Name: with colon", models: [{ id: "m" }] } },
    };
    assert.match(renderOverlay(routes), /displayName: "Name: with colon"/);
    assert.deepEqual(renderOverlay(routes), renderOverlay(routes));
    const { value } = parseYaml(renderOverlay(routes));
    assert.equal(value[0].config.providers.p.displayName, "Name: with colon");
  });

  test("validation rejects a broken route table without echoing key material", () => {
    assert.throws(() => renderOverlay(null), /routes must be an object/);
    assert.throws(() => renderOverlay({ providers: {}, default: {} }), /providers is empty/);
    assert.throws(
      () => renderOverlay({ default: {}, providers: { p: { models: [{ id: "m" }] } } }),
      /apiKeyEnv is required/,
    );
    assert.throws(
      () => renderOverlay({ default: {}, providers: { p: { apiKeyEnv: "K", models: [] } } }),
      /models must be a non-empty array/,
    );
    const bad = {
      providers: { p: { apiKeyEnv: "K", models: [{ id: "m" }] } },
      default: { provider: "q", model: "m", reasoningEffort: "max" },
    };
    assert.throws(() => renderOverlay(bad), /provider "q" is not in routes.providers/);
    const badModel = {
      providers: { p: { apiKeyEnv: "K", models: [{ id: "m" }] } },
      default: { provider: "p", model: "nope", reasoningEffort: "max" },
    };
    assert.throws(() => renderOverlay(badModel), /model "nope" is not offered/);
    assert.equal(validateRoutes(DEFAULT_ROUTES), DEFAULT_ROUTES);
  });
});

describe("overlayPath", () => {
  test("XDG_CONFIG_HOME wins, otherwise ~/.config", () => {
    assert.equal(
      overlayPath({ XDG_CONFIG_HOME: "/tmp/xdg", HOME: "/home/u" }),
      join("/tmp/xdg", "t3code-bridge-dsh", "routes.yml"),
    );
    assert.equal(overlayPath({ HOME: "/home/u" }), join("/home/u", ".config", "t3code-bridge-dsh", "routes.yml"));
    assert.ok(overlayPath({ HOME: "relative-home" }).startsWith("/"), "always absolute");
  });
});

describe("writeOverlay", () => {
  test("creates the file and reports changed once", () => {
    const dir = tempDir();
    const target = join(dir, "nested", "routes.yml");
    assert.deepEqual(writeOverlay(target), { changed: true });
    assert.equal(readFileSync(target, "utf8"), renderOverlay());
    assert.deepEqual(writeOverlay(target), { changed: false }, "an identical file is not rewritten");
    assert.deepEqual(readdirSync(join(dir, "nested")), ["routes.yml"], "no temp file is left behind");
  });

  test("rewrites when the content differs", () => {
    const dir = tempDir();
    const target = join(dir, "routes.yml");
    writeFileSync(target, "- id: something-else\n");
    assert.deepEqual(writeOverlay(target), { changed: true });
    assert.equal(readFileSync(target, "utf8"), renderOverlay());
  });

  test("dry run writes nothing but reports the change", () => {
    const dir = tempDir();
    const target = join(dir, "routes.yml");
    assert.deepEqual(writeOverlay(target, { dryRun: true }), { changed: true });
    assert.equal(existsSync(target), false);
    writeFileSync(target, "old\n");
    assert.deepEqual(writeOverlay(target, { dryRun: true }), { changed: true });
    assert.equal(readFileSync(target, "utf8"), "old\n");
    mkdirSync(join(dir, "empty"));
    assert.deepEqual(writeOverlay(join(dir, "empty", "routes.yml"), { dryRun: true }), { changed: true });
    assert.deepEqual(readdirSync(join(dir, "empty")), []);
  });

  test("a route table that fails validation writes nothing", () => {
    const dir = tempDir();
    const target = join(dir, "routes.yml");
    assert.throws(() => writeOverlay(target, { routes: { providers: {} } }), /providers is empty/);
    assert.equal(existsSync(target), false);
    assert.throws(() => writeOverlay(""), /path is required/);
  });
});

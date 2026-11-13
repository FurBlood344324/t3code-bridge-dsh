// Secret resolution: API key *values* live only in the environment of the child process.
//
// Order per env var name: process env, then `<DSH_HOME>/.env`, then pi auth
// (`~/.pi/agent/auth.json`), then opencode auth (`~/.local/share/opencode/auth.json`).
// A missing, unreadable or malformed file is skipped: one broken source must not cost the
// operator a working provider. `resolveKeys` returns values for spawning plus a report that
// carries names, state, source and length only; `maskReport` turns the report into display lines.
// Nothing here ever logs a value, and no error message includes one.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Source tokens used in reports (stable strings: they appear in operator-facing output). */
export const SOURCE_ENV = "env";
export const SOURCE_DOTENV = "dsh.env";
export const SOURCE_PI_AUTH = "pi-auth";
export const SOURCE_OPENCODE_AUTH = "opencode-auth";

/**
 * The provider tables ARE the mapping: a name that is not here has no source, so the overlay and
 * this file cannot drift apart silently (a test compares them against `renderOverlay`).
 */
export const PROVIDERS = Object.freeze([
  Object.freeze({
    name: "OPEN_DESIGN_API_KEY",
    piProvider: "opendesign",
    opencodeProvider: null,
  }),
  Object.freeze({
    name: "COMMAND_CODE_API_KEY",
    piProvider: "command-code",
    opencodeProvider: null,
  }),
  Object.freeze({
    name: "OPENCODE_GO_API_KEY",
    piProvider: null,
    opencodeProvider: "opencode-go",
  }),
]);

/** pi auth provider name -> env var name. */
export const PI_PROVIDERS = Object.freeze(
  Object.fromEntries(PROVIDERS.filter((p) => p.piProvider).map((p) => [p.piProvider, p.name])),
);

/** opencode auth provider name -> env var name. */
export const OPENCODE_PROVIDERS = Object.freeze(
  Object.fromEntries(PROVIDERS.filter((p) => p.opencodeProvider).map((p) => [p.opencodeProvider, p.name])),
);

/**
 * Where each key comes from, in precedence order: process env, `<DSH_HOME>/.env`, then the auth
 * file that owns that provider (pi for the two, opencode for opencode-go).
 */
export const SOURCES = Object.freeze(
  PROVIDERS.map((provider) => {
    const chain = [{ source: SOURCE_ENV, kind: "env" }, { source: SOURCE_DOTENV, kind: "envfile" }];
    if (provider.piProvider) {
      chain.push({ source: SOURCE_PI_AUTH, kind: "authfile", file: "piAuth", provider: provider.piProvider });
    } else {
      chain.push({
        source: SOURCE_OPENCODE_AUTH,
        kind: "authfile",
        file: "opencodeAuth",
        provider: provider.opencodeProvider,
      });
    }
    return Object.freeze({ name: provider.name, chain: Object.freeze(chain.map(Object.freeze)) });
  }),
);

/** Every env var name this module resolves, in report order. */
export const KEY_NAMES = Object.freeze(SOURCES.map((entry) => entry.name));

function homeOf(env) {
  const raw = env && typeof env.HOME === "string" ? env.HOME.trim() : "";
  return isAbsolute(raw) ? resolve(raw) : resolve(homedir());
}

/** `<DSH_HOME>` or `~/.dsh`, absolute. Kept local so this module does not depend on profiles.js. */
export function defaultDshHome(env = process.env) {
  const raw = env && typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  return resolve(raw || join(homeOf(env), ".dsh"));
}

/** Absolute paths this module reads, from the process env unless the caller says otherwise. */
export function defaultPaths(env = process.env) {
  const home = homeOf(env);
  return {
    dshHome: defaultDshHome(env),
    piAuthPath: join(home, ".pi", "agent", "auth.json"),
    opencodeAuthPath: join(home, ".local", "share", "opencode", "auth.json"),
  };
}

/** Field names an auth-file entry may carry the secret in, most specific first. */
const AUTH_VALUE_FIELDS = Object.freeze(["key", "apiKey", "token", "accessToken"]);

/** Pull one key out of `{ provider: { key | apiKey | ... } }` (or `{ provider: "<value>" }`). */
function authValue(json, provider) {
  if (!json || typeof json !== "object") return null;
  const entry = json[provider];
  if (typeof entry === "string") return entry.trim() || null;
  if (!entry || typeof entry !== "object") return null;
  for (const field of AUTH_VALUE_FIELDS) {
    const value = entry[field];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

const DOUBLE_QUOTE_ESCAPES = Object.freeze({ n: "\n", t: "\t", '"': '"', "\\": "\\" });

/**
 * Read a value: a leading quote is closed by its matching quote and anything after it (a trailing
 * `# comment`) is ignored; escapes in double quotes are expanded in ONE pass so `\\n` stays a
 * backslash plus `n`. An unquoted value ends at whitespace followed by `#`.
 */
function unquote(raw) {
  const text = raw.trim();
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    let i = 1;
    let out = "";
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (quote === '"' && ch === "\\" && i + 1 < text.length) {
        const mapped = DOUBLE_QUOTE_ESCAPES[text[i + 1]];
        if (mapped !== undefined) {
          out += mapped;
          i += 1;
          continue;
        }
      }
      if (ch === quote) return out;
      out += ch;
    }
    // no closing quote: treat the whole text as an unquoted literal below
  }
  const hash = text.search(/\s#/);
  return (hash === -1 ? text : text.slice(0, hash)).trim();
}

/**
 * Parse `KEY=VALUE` lines. Blank lines and `#` comments are ignored, `export ` prefixes are
 * tolerated, later assignments win, and an unparsable line is skipped instead of thrown.
 * @returns {Map<string, string>}
 */
export function parseDotEnv(text) {
  const values = new Map();
  if (typeof text !== "string") return values;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const name = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const value = unquote(body.slice(eq + 1));
    values.set(name, value);
  }
  return values;
}

/** Read a file as text, or null when it is missing/unreadable. Never throws. */
function readTextOrNull(path) {
  if (typeof path !== "string" || path.trim() === "") return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Read and parse JSON, or null when it is missing/unreadable/not an object. Never throws. */
function readJsonOrNull(path) {
  const text = readTextOrNull(path);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Resolve every key in `SOURCES` against the configured sources.
 * @param {{env?: object, dshHome?: string, piAuthPath?: string, opencodeAuthPath?: string}} [options]
 * Rows carry `{name, state, source, length}` exactly as the spec binds them; the file a key came
 * from is `defaultPaths()`' business, so no path travels in the row.
 * @returns {{env: Record<string,string>, report: Array<{name: string, state: "set"|"unset",
 *   source: string|null, length: number}>}}
 */
export function resolveKeys({
  env = process.env,
  dshHome,
  piAuthPath,
  opencodeAuthPath,
} = {}) {
  const baseEnv = env && typeof env === "object" ? env : {};
  const paths = {
    dshHome: dshHome ? resolve(dshHome) : defaultDshHome(baseEnv),
    piAuthPath,
    opencodeAuthPath,
  };
  if (!paths.piAuthPath || !paths.opencodeAuthPath) {
    const derived = defaultPaths(baseEnv);
    paths.piAuthPath = paths.piAuthPath || derived.piAuthPath;
    paths.opencodeAuthPath = paths.opencodeAuthPath || derived.opencodeAuthPath;
  }
  const dotenvPath = join(paths.dshHome, ".env");

  // Each file is read at most once per call, and only when some chain still needs it.
  const cache = new Map();
  const dotenv = () => {
    if (!cache.has("dotenv")) cache.set("dotenv", parseDotEnv(readTextOrNull(dotenvPath)));
    return cache.get("dotenv");
  };
  const authFile = (key) => {
    if (!cache.has(key)) {
      cache.set(key, readJsonOrNull(key === "piAuth" ? paths.piAuthPath : paths.opencodeAuthPath));
    }
    return cache.get(key);
  };

  const resolved = {};
  const report = [];
  for (const entry of SOURCES) {
    let found = null;
    let source = null;
    for (const step of entry.chain) {
      if (step.kind === "env") {
        const raw = baseEnv[entry.name];
        if (typeof raw === "string" && raw.trim() !== "") {
          found = raw.trim();
          source = SOURCE_ENV;
          break;
        }
        continue;
      }
      if (step.kind === "envfile") {
        const value = dotenv().get(entry.name);
        if (typeof value === "string" && value !== "") {
          found = value;
          source = SOURCE_DOTENV;
          break;
        }
        continue;
      }
      if (step.kind === "authfile") {
        const json = authFile(step.file);
        const value = json ? authValue(json, step.provider) : null;
        if (value) {
          found = value;
          source = step.source;
          break;
        }
      }
    }
    if (found === null) {
      report.push({ name: entry.name, state: "unset", source: null, length: 0 });
      continue;
    }
    resolved[entry.name] = found;
    report.push({ name: entry.name, state: "set", source, length: found.length });
  }

  return { env: resolved, report };
}

/**
 * Display lines for a report: names, state, source and length. Never a value.
 * @returns {string[]}
 */
export function maskReport(report) {
  const rows = Array.isArray(report) ? report : [];
  return rows.map((row) => {
    const name = row && typeof row.name === "string" ? row.name : "(unnamed)";
    if (!row || row.state !== "set") return `${name} unset`;
    const source = row.source || "unknown";
    const length = Number.isFinite(row.length) ? row.length : 0;
    return `${name} set ${source} len=${length}`;
  });
}

/** Names that are still unset, for a caller that wants to fail loudly. */
export function missingKeys(report) {
  return (Array.isArray(report) ? report : [])
    .filter((row) => !row || row.state !== "set")
    .map((row) => (row && row.name) || "(unnamed)");
}

// Minimal YAML reader for the subset this repo generates: block maps, block lists of maps,
// block lists of scalars, quoted/plain scalars, booleans/numbers, and one-line flow maps.
// Tests use it to assert the *structure* of an overlay instead of matching substrings.
// It refuses anything it does not understand, so a golden test cannot pass by accident.

function splitFlow(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

function splitKey(text) {
  // `key: value` / `key:` — the colon must be followed by a space or end the line.
  const match = /^([^:'"]+?):(?:\s+(.*))?$/.exec(text);
  return match ? { key: match[1].trim(), value: match[2] === undefined ? null : match[2].trim() } : null;
}

function scalarValue(raw) {
  const text = raw.trim();
  if (text.startsWith("{") && text.endsWith("}")) {
    const map = {};
    for (const part of splitFlow(text.slice(1, -1))) {
      const entry = splitKey(part.trim());
      if (!entry) throw new Error(`flow map entry without a colon: ${part}`);
      map[entry.key] = entry.value === null ? null : scalarValue(entry.value);
    }
    return map;
  }
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`double-quoted scalar is not JSON-escaped: ${text}`);
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

/** Parse the subset. Returns `{ value, comments }` where `comments` are the full-line comments. */
export function parseYaml(text) {
  if (typeof text !== "string") throw new Error("parseYaml: text is required");
  const comments = [];
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    if (raw.trimStart().startsWith("#")) {
      comments.push(raw.trim());
      continue;
    }
    if (/\t/.test(raw)) throw new Error("parseYaml: tabs are not valid indentation");
    const indent = raw.length - raw.trimStart().length;
    lines.push({ indent, text: raw.trim() });
  }

  let index = 0;
  const peek = () => lines[index];
  const isItem = () => {
    const line = peek();
    return Boolean(line) && line.text.startsWith("- ");
  };

  function parseBlock(indent) {
    const line = peek();
    if (!line) return null;
    if (isItem()) return parseList(indent);
    return parseMap(indent);
  }

  function parseMap(indent) {
    const result = {};
    while (index < lines.length) {
      const line = lines[index];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new Error(`parseYaml: unexpected indentation at "${line.text}"`);
      if (line.text.startsWith("- ")) break;
      const entry = splitKey(line.text);
      if (!entry) throw new Error(`parseYaml: not a map entry: "${line.text}"`);
      index += 1;
      if (entry.value === null) {
        const next = peek();
        result[entry.key] = next && next.indent > indent ? parseBlock(next.indent) : null;
      } else {
        result[entry.key] = scalarValue(entry.value);
      }
    }
    return result;
  }

  function parseList(indent) {
    const result = [];
    while (index < lines.length) {
      const line = lines[index];
      if (line.indent !== indent || !line.text.startsWith("- ")) break;
      const rest = line.text.slice(2).trim();
      index += 1;
      if (rest === "") {
        const next = peek();
        result.push(next && next.indent > indent ? parseBlock(next.indent) : null);
        continue;
      }
      const entry = splitKey(rest);
      if (!entry) {
        result.push(scalarValue(rest));
        continue;
      }
      // `- key: value` opens a map whose remaining keys sit at indent + 2.
      const item = {};
      if (entry.value === null) {
        const next = peek();
        item[entry.key] = next && next.indent > indent + 2 ? parseBlock(next.indent) : null;
      } else {
        item[entry.key] = scalarValue(entry.value);
      }
      while (index < lines.length) {
        const more = lines[index];
        if (more.indent !== indent + 2 || more.text.startsWith("- ")) break;
        const nested = splitKey(more.text);
        if (!nested) throw new Error(`parseYaml: not a map entry: "${more.text}"`);
        index += 1;
        if (nested.value === null) {
          const next = peek();
          item[nested.key] = next && next.indent > indent + 2 ? parseBlock(next.indent) : null;
        } else {
          item[nested.key] = scalarValue(nested.value);
        }
      }
      result.push(item);
    }
    return result;
  }

  const value = parseBlock(lines.length === 0 ? 0 : lines[0].indent);
  if (index !== lines.length) throw new Error(`parseYaml: ${lines.length - index} trailing lines`);
  return { value, comments };
}

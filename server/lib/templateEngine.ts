/**
 * Render percent-delimited variables without relying on platform globals.
 *
 * A variable name is a non-empty run without whitespace or percent signs.
 * This keeps an unmatched percent in ordinary text such as "100% cotton"
 * from consuming a later, valid variable token.
 */

function isVariableName(name: string): boolean {
  return name.length > 0 && !/[\s%]/.test(name);
}

function scanTemplate(
  template: string,
  onVariable: (name: string) => string,
): string {
  let result = "";
  let index = 0;

  while (index < template.length) {
    if (template[index] !== "%") {
      result += template[index];
      index += 1;
      continue;
    }

    // Escapes take precedence over variable parsing. In particular,
    // "%%title%%" becomes the literal string "%title%".
    if (template[index + 1] === "%") {
      result += "%";
      index += 2;
      continue;
    }

    const closingPercent = template.indexOf("%", index + 1);
    if (closingPercent !== -1) {
      const name = template.slice(index + 1, closingPercent);
      if (isVariableName(name)) {
        result += onVariable(name);
        index = closingPercent + 1;
        continue;
      }
    }

    // An unmatched or invalid percent is literal text.
    result += "%";
    index += 1;
  }

  return result;
}

function isWhitespaceOnly(value: string): boolean {
  return /^[\s]*$/.test(value);
}

function collapseSeparators(text: string, separator: string): string {
  let result = text;
  let searchStart = 0;

  while (true) {
    const first = result.indexOf(separator, searchStart);
    if (first === -1) {
      break;
    }

    const next = result.indexOf(separator, first + separator.length);
    if (
      next !== -1 &&
      isWhitespaceOnly(result.slice(first + separator.length, next))
    ) {
      result =
        result.slice(0, first + separator.length) +
        result.slice(next + separator.length);
      searchStart = first;
    } else {
      searchStart = first + separator.length;
    }
  }

  const leadingSeparator = result.indexOf(separator);
  if (
    leadingSeparator !== -1 &&
    isWhitespaceOnly(result.slice(0, leadingSeparator))
  ) {
    result = result.slice(leadingSeparator + separator.length);
  }

  const trailingSeparator = result.lastIndexOf(separator);
  if (
    trailingSeparator !== -1 &&
    isWhitespaceOnly(result.slice(trailingSeparator + separator.length))
  ) {
    result = result.slice(0, trailingSeparator);
  }

  return result;
}

/**
 * Hard cap on a RENDERED template, in Unicode code points.
 *
 * The template itself is bounded at save time (TITLE_TEMPLATE_MAX = 300), but
 * the values substituted into it are not: `%title%` renders the document's own
 * `<title>` text, and a ~300-character template holds ~37 `%title%` references.
 * Without this cap a 10k-character document title renders a ~370KB title that
 * is then copied into `<title>`, og:title, twitter:title, the fingerprint stash
 * and the schema graph. 512 is far past any usable SERP title.
 */
export const RENDERED_TEMPLATE_MAX = 512;

/** Truncate to `max` CODE POINTS (never splits a surrogate pair). */
function clampCodePoints(text: string, max: number): string {
  // UTF-16 length >= code-point count, so this fast path can never truncate.
  if (text.length <= max) {
    return text;
  }
  let out = "";
  let count = 0;
  for (const ch of text) {
    if (count === max) {
      break;
    }
    out += ch;
    count += 1;
  }
  return out;
}

/**
 * Render a title template using the supplied variable values.
 *
 * The result is whitespace-collapsed, trimmed and clamped to
 * RENDERED_TEMPLATE_MAX code points.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string | undefined>,
): string {
  let hadEmptyVariable = false;

  let rendered = scanTemplate(template, (name) => {
    // Own-property read only: `vars` is a plain object, so a template var
    // like %toString% would otherwise splice inherited native-function
    // source into the output (reachable from the admin preview path).
    // hasOwnProperty.call, not Object.hasOwn — QuickJS has no ES2022.
    const value = Object.prototype.hasOwnProperty.call(vars, name)
      ? vars[name]
      : undefined;
    if (value === undefined || value === "") {
      hadEmptyVariable = true;
      return "";
    }
    return value;
  });

  const separator = vars.sep;
  if (hadEmptyVariable && separator !== undefined && separator !== "") {
    rendered = collapseSeparators(rendered, separator);
  }

  return clampCodePoints(
    rendered.replace(/\s+/g, " ").trim(),
    RENDERED_TEMPLATE_MAX,
  );
}

/** Return distinct variable names in their first-appearance order. */
export function extractVariables(template: string): string[] {
  const variables: string[] = [];

  scanTemplate(template, (name) => {
    if (variables.indexOf(name) === -1) {
      variables.push(name);
    }
    return "";
  });

  return variables;
}

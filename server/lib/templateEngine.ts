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

/** Render a title template using the supplied variable values. */
export function renderTemplate(
  template: string,
  vars: Record<string, string | undefined>,
): string {
  let hadEmptyVariable = false;

  let rendered = scanTemplate(template, (name) => {
    const value = vars[name];
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

  return rendered.replace(/\s+/g, " ").trim();
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

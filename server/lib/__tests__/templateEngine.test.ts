import { describe, expect, it } from "bun:test";
import {
  extractVariables,
  renderTemplate,
  RENDERED_TEMPLATE_MAX,
} from "../templateEngine";

describe("renderTemplate", () => {
  it("never reads inherited object properties as variables (round 5 wave 2 O#6b)", () => {
    // %toString% / %constructor% would otherwise splice native-function
    // source into a previewed title (admin preview path).
    expect(renderTemplate("%toString%", { title: "A page" })).toBe("");
    expect(renderTemplate("%constructor%", { title: "A page" })).toBe("");
    expect(renderTemplate("%hasOwnProperty% %title%", { title: "A page" })).toBe("A page");
  });

  it("substitutes all standard variables", () => {
    expect(
      renderTemplate("%title% %sep% %site% — %excerpt% [%table%]", {
        title: "A page",
        sep: "|",
        site: "Example",
        excerpt: "A short summary",
        table: "Docs",
      }),
    ).toBe("A page | Example — A short summary [Docs]");
  });

  it("collapses separators around empty variables", () => {
    expect(
      renderTemplate("%title% %sep% %site%", {
        title: "",
        sep: "|",
        site: "Site",
      }),
    ).toBe("Site");

    expect(
      renderTemplate("%title% %sep% %site%", {
        title: "Title",
        sep: "|",
        site: "",
      }),
    ).toBe("Title");

    expect(
      renderTemplate("%title% %sep% %missing% %sep% %site%", {
        title: "Title",
        sep: "|",
        site: "Site",
      }),
    ).toBe("Title | Site");

    expect(
      renderTemplate("%a% %sep% %b% %sep% %c%", {
        a: "",
        b: "",
        c: "Content",
        sep: "|",
      }),
    ).toBe("Content");
  });

  it("treats regex-special separators as literal strings", () => {
    for (const separator of ["|", ".", "·", "("]) {
      expect(
        renderTemplate("%title% %sep% %missing% %sep% %site%", {
          title: "Title",
          sep: separator,
          site: "Site",
        }),
      ).toBe(`Title ${separator} Site`);
    }
  });

  it("renders escaped percents and keeps them separate from variables", () => {
    expect(renderTemplate("Discount: 20%%", {})).toBe("Discount: 20%");
    expect(renderTemplate("%%title%%", { title: "Rendered" })).toBe(
      "%title%",
    );
    expect(renderTemplate("%% %title% %%", { title: "Rendered" })).toBe(
      "% Rendered %",
    );
  });

  it("keeps unmatched percent signs literal", () => {
    // A percent followed by ordinary text is treated as literal text; a later
    // well-formed token is still rendered.
    expect(renderTemplate("100% cotton", {})).toBe("100% cotton");
    expect(renderTemplate("100% cotton %title%", { title: "shirts" })).toBe(
      "100% cotton shirts",
    );
    expect(renderTemplate("Odd % sign %title", { title: "shirts" })).toBe(
      "Odd % sign %title",
    );
  });

  it("collapses whitespace and trims the result", () => {
    expect(renderTemplate("  %title%\n\t %site%   ", { title: "One", site: "Two" })).toBe(
      "One Two",
    );
    expect(renderTemplate("  plain\n text  ", {})).toBe("plain text");
  });

  it("skips separator collapsing when sep is empty or undefined", () => {
    expect(renderTemplate("%title% | %site%", { title: "", site: "Site" })).toBe(
      "| Site",
    );
    expect(
      renderTemplate("%title% %sep% %site%", {
        title: "",
        sep: "",
        site: "Site",
      }),
    ).toBe("Site");
  });

  it("handles an empty template and a template with no variables", () => {
    expect(renderTemplate("", {})).toBe("");
    expect(renderTemplate("  static   text  ", {})).toBe("static text");
  });

  // round-5 item 5: the template is capped at save time (300 chars) but the
  // values substituted INTO it are not — %title% renders the document's own
  // <title>, and a 300-char template holds ~37 references to it.
  it("clamps the rendered output so a huge %title% cannot explode the title", () => {
    const template = "%title% ".repeat(37).trim();
    const rendered = renderTemplate(template, { title: "x".repeat(10_000) });
    expect(rendered.length).toBe(RENDERED_TEMPLATE_MAX);
  });

  it("clamping counts CODE POINTS and never splits a surrogate pair", () => {
    const rendered = renderTemplate("%title%", {
      title: "😀".repeat(RENDERED_TEMPLATE_MAX + 10),
    });
    expect([...rendered].length).toBe(RENDERED_TEMPLATE_MAX);
    expect([...rendered].every((ch) => ch === "😀")).toBe(true);
  });

  it("leaves any realistic title untouched", () => {
    const normal = renderTemplate("%title% | %site%", {
      title: "A Perfectly Ordinary Page Title",
      site: "Example",
    });
    expect(normal).toBe("A Perfectly Ordinary Page Title | Example");
  });
});

describe("extractVariables", () => {
  it("returns distinct names in first-appearance order and ignores escapes", () => {
    expect(
      extractVariables("%%title%% %site% %title% %sep% %site% %% %table%"),
    ).toEqual(["site", "title", "sep", "table"]);
  });
});

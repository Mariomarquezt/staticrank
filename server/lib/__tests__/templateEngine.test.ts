import { describe, expect, it } from "bun:test";
import { extractVariables, renderTemplate } from "../templateEngine";

describe("renderTemplate", () => {
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
});

describe("extractVariables", () => {
  it("returns distinct names in first-appearance order and ignores escapes", () => {
    expect(
      extractVariables("%%title%% %site% %title% %sep% %site% %% %table%"),
    ).toEqual(["site", "title", "sep", "table"]);
  });
});

import { describe, it, expect } from "vitest";
import { TEMPLATES, findTemplate } from "../services/templates";
import { en } from "../i18n/en";

describe("project templates", () => {
  it("have unique ids, translated names and a well-formed main.tex", () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of TEMPLATES) {
      expect(en[template.nameKey], `${template.id} name key`).toBeTruthy();
      expect(en[template.descriptionKey], `${template.id} description key`).toBeTruthy();
      const main = template.files.find((f) => f.path === "main.tex");
      expect(main, `${template.id} needs main.tex`).toBeDefined();
      expect(main!.content).toMatch(/\\documentclass/);
      expect(main!.content).toMatch(/\\begin\{document\}/);
      expect(main!.content).toMatch(/\\end\{document\}\s*$/);
      for (const file of template.files) {
        expect(file.path).not.toMatch(/^\/|\.\./);
      }
    }
  });

  it("every \\input / \\include in a template points to a file the template ships", () => {
    for (const template of TEMPLATES) {
      const paths = new Set(template.files.map((f) => f.path));
      for (const file of template.files) {
        for (const m of file.content.matchAll(/\\(?:input|include)\{([^}]+)\}/g)) {
          const target = m[1].endsWith(".tex") ? m[1] : `${m[1]}.tex`;
          expect(paths.has(target), `${template.id}: missing ${target}`).toBe(true);
        }
        for (const m of file.content.matchAll(/\\bibliography\{([^}]+)\}/g)) {
          expect(paths.has(`${m[1]}.bib`), `${template.id}: missing ${m[1]}.bib`).toBe(true);
        }
      }
    }
    expect(findTemplate("article")?.files.some((f) => f.path === "refs.bib")).toBe(true);
    // The report template uses \include so chapters can be built one at a time.
    expect(findTemplate("report")?.files[0].content).toMatch(/\\include\{chapters\/introduction\}/);
    expect(findTemplate("nope")).toBeUndefined();
  });
});

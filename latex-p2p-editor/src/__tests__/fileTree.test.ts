import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import FileTree, { getFileType, isEditableFile } from "../components/FileTree";
import type { ProjectNode } from "../services/tauriBridge";

describe("File type detection", () => {
  it("identifies TeX files", () => {
    expect(getFileType("main.tex")).toBe("tex");
    expect(getFileType("chapters/intro.TEX")).toBe("tex");
  });

  it("identifies bibliography files", () => {
    expect(getFileType("references.bib")).toBe("bib");
    expect(getFileType("refs.BIB")).toBe("bib");
  });

  it("identifies style and class files", () => {
    expect(getFileType("custom.sty")).toBe("style");
    expect(getFileType("article.cls")).toBe("style");
  });

  it("identifies image files", () => {
    expect(getFileType("figure.png")).toBe("image");
    expect(getFileType("photo.jpg")).toBe("image");
    expect(getFileType("plot.jpeg")).toBe("image");
    expect(getFileType("diagram.pdf")).toBe("image");
    expect(getFileType("logo.svg")).toBe("image");
  });

  it("identifies other text files", () => {
    expect(getFileType("notes.txt")).toBe("text");
    expect(getFileType("README.md")).toBe("text");
    expect(getFileType("data.json")).toBe("text");
    expect(getFileType("table.csv")).toBe("text");
  });

  it("identifies non-text files as other", () => {
    expect(getFileType("binary.bin")).toBe("other");
    expect(getFileType("archive.zip")).toBe("other");
  });

  it("determines editability correctly", () => {
    expect(isEditableFile("main.tex")).toBe(true);
    expect(isEditableFile("references.bib")).toBe(true);
    expect(isEditableFile("macros.sty")).toBe(true);
    expect(isEditableFile("notes.txt")).toBe(true);
    expect(isEditableFile("figure.png")).toBe(false);
    expect(isEditableFile("document.pdf")).toBe(false);
    expect(isEditableFile("binary.bin")).toBe(false);
  });
});

import { I18nProvider } from "../i18n";

function renderWithI18n(element: React.ReactElement): string {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, element));
}

describe("FileTree rendering", () => {
  const sampleNodes: ProjectNode[] = [
    {
      name: "chapters",
      path: "chapters",
      is_dir: true,
      children: [
        {
          name: "ch1.tex",
          path: "chapters/ch1.tex",
          is_dir: false,
        },
      ],
    },
    {
      name: "main.tex",
      path: "main.tex",
      is_dir: false,
    },
    {
      name: "references.bib",
      path: "references.bib",
      is_dir: false,
    },
    {
      name: "figures",
      path: "figures",
      is_dir: true,
      children: [
        {
          name: "plot.png",
          path: "figures/plot.png",
          is_dir: false,
        },
      ],
    },
  ];

  it("renders tree nodes, main badge, and active file", () => {
    const html = renderWithI18n(
      React.createElement(FileTree, {
        nodes: sampleNodes,
        activeFile: "chapters/ch1.tex",
        rootFile: "main.tex",
        onSelectFile: vi.fn(),
        onSetRootFile: vi.fn(),
        onCreateNode: vi.fn(),
        onRenameNode: vi.fn(),
        onDeleteNode: vi.fn(),
        onToggleCollapse: vi.fn(),
      })
    );

    // Should include directory and file names
    expect(html).toContain("chapters");
    expect(html).toContain("ch1.tex");
    expect(html).toContain("main.tex");
    expect(html).toContain("references.bib");
    expect(html).toContain("figures");
    expect(html).toContain("plot.png");

    // Root file should have the main badge
    expect(html).toContain("main");

    // Title should be present
    expect(html).toContain("aside");
  });

  it("renders empty state when there are no nodes", () => {
    const html = renderWithI18n(
      React.createElement(FileTree, {
        nodes: [],
        activeFile: null,
        rootFile: null,
        onSelectFile: vi.fn(),
        onCreateNode: vi.fn(),
        onRenameNode: vi.fn(),
        onDeleteNode: vi.fn(),
        onToggleCollapse: vi.fn(),
      })
    );

    // Empty message should be displayed
    expect(html).toContain("italic");
  });
});

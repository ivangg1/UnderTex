// CodeMirror completion source over the project reference index:
// \ref{…} → labels of every file, \cite{…} → .bib keys,
// \input / \includegraphics / \bibliography → project files.

import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { candidatesFor, refContext, type ProjectIndex } from "./references";

export function referenceCompletionSource(getIndex: () => ProjectIndex | null, getRootFile: () => string) {
  return (context: CompletionContext): CompletionResult | null => {
    const index = getIndex();
    if (!index) return null;
    const line = context.state.doc.lineAt(context.pos);
    const ctx = refContext(line.text.slice(0, context.pos - line.from));
    if (!ctx) return null;
    const options = candidatesFor(ctx, index, getRootFile()).map((c) => ({
      label: c.label,
      detail: c.detail,
      info: c.info,
      type: c.type === "label" ? "variable" : c.type === "cite" ? "text" : "namespace",
    }));
    return { from: line.from + ctx.from, options, validFor: /^[^{},\s]*$/ };
  };
}

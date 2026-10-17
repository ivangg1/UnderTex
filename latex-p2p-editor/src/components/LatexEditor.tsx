// LatexEditor: CodeMirror 6 bound to a Y.Text through y-codemirror.next.
//
// The editor is always backed by the session's Y.Text (solo mode included), so
// there is a single source of truth for the document and undo/redo is handled
// by Yjs' UndoManager: each user undoes only their own changes, never the
// edits received from remote peers.

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import {
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  indentOnInput,
} from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { latex } from "codemirror-lang-latex";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

export interface LatexEditorHandle {
  /** Scrolls to and selects the given 1-based line. */
  goToLine: (line: number) => void;
  focus: () => void;
}

interface LatexEditorProps {
  ytext: Y.Text;
  awareness: Awareness;
}

/** Monokai Pro highlight style tuned for LaTeX. */
const latexHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "#ff6188" },
  { tag: [tags.controlKeyword, tags.definitionKeyword], color: "#ff6188" },
  { tag: [tags.function(tags.variableName), tags.macroName], color: "#a9dc76" },
  { tag: [tags.typeName, tags.className, tags.labelName], color: "#78dce8" },
  { tag: [tags.string, tags.special(tags.string)], color: "#ffd866" },
  { tag: tags.comment, color: "#727072", fontStyle: "italic" },
  { tag: [tags.number, tags.atom, tags.bool], color: "#ab9df2" },
  { tag: [tags.operator, tags.punctuation], color: "#fc9867" },
  { tag: [tags.bracket, tags.paren, tags.brace], color: "#c1c0c0" },
  { tag: tags.heading, color: "#ffd866", fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.invalid, color: "#ff6188", textDecoration: "underline wavy" },
]);

const editorTheme = EditorView.theme(
  {
    "&": { height: "100%", fontSize: "13.5px", backgroundColor: "#2d2a2e", color: "#fcfcfa" },
    ".cm-scroller": {
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', Menlo, Consolas, monospace",
      lineHeight: "1.6",
    },
    ".cm-content": { caretColor: "#fcfcfa", padding: "10px 0" },
    "&.cm-focused .cm-cursor": { borderLeftColor: "#fcfcfa" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "#5b595c !important",
    },
    ".cm-activeLine": { backgroundColor: "#35333666" },
    ".cm-gutters": { backgroundColor: "#2d2a2e", color: "#5b595c", border: "none", paddingRight: "6px" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#c1c0c0" },
    ".cm-selectionMatch": { backgroundColor: "#5b595c80" },
    ".cm-matchingBracket": { backgroundColor: "#5b595c", outline: "1px solid #939293" },
    ".cm-tooltip": { backgroundColor: "#221f22", border: "1px solid #403e41", color: "#fcfcfa" },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "#403e41",
      color: "#fcfcfa",
    },
    ".cm-panels": { backgroundColor: "#221f22", color: "#fcfcfa" },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid #403e41" },
    ".cm-searchMatch": { backgroundColor: "#ffd86640", outline: "1px solid #ffd86680" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#fc986780" },
    ".cm-panel input, .cm-panel button": {
      backgroundColor: "#2d2a2e",
      color: "#fcfcfa",
      border: "1px solid #403e41",
      borderRadius: "0",
    },
  },
  { dark: true }
);

const LatexEditor = forwardRef<LatexEditorHandle, LatexEditorProps>(function LatexEditor(
  { ytext, awareness },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      goToLine(line: number) {
        const view = viewRef.current;
        if (!view) return;
        const clamped = Math.max(1, Math.min(line, view.state.doc.lines));
        const info = view.state.doc.line(clamped);
        view.dispatch({
          selection: { anchor: info.from, head: info.to },
          effects: EditorView.scrollIntoView(info.from, { y: "center" }),
        });
        view.focus();
      },
      focus() {
        viewRef.current?.focus();
      },
    }),
    []
  );

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        crosshairCursor(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        search({ top: true }),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        keymap.of([
          ...yUndoManagerKeymap,
          ...closeBracketsKeymap,
          ...searchKeymap,
          ...completionKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),
        latex({ enableLinting: false, enableTooltips: false }),
        syntaxHighlighting(latexHighlightStyle, { fallback: true }),
        yCollab(ytext, awareness),
        editorTheme,
      ],
    });

    const view = new EditorView({ state, parent });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [ytext, awareness]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden" />;
});

export default LatexEditor;

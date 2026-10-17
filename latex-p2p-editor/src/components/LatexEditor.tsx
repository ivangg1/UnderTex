// LatexEditor: CodeMirror 6 bound to a Y.Text through y-codemirror.next.
//
// The editor is always backed by the session's Y.Text (solo mode included), so
// there is a single source of truth for the document and undo/redo is handled
// by Yjs' UndoManager: each user undoes only their own changes, never the
// edits received from remote peers.

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { UndoManager } from "yjs";
import { Compartment, EditorState } from "@codemirror/state";
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
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, startCompletion } from "@codemirror/autocomplete";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { latex, latexCompletionSource } from "codemirror-lang-latex";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { activeChapter } from "../services/chapters";
import { findDefinition, type Definition, type ProjectIndex } from "../services/references";
import { referenceCompletionSource } from "../services/referenceCompletion";
import type { ResolvedTheme } from "../services/theme";

export interface LatexEditorHandle {
  /** Scrolls to and selects the given 1-based line. */
  goToLine: (line: number) => void;
  focus: () => void;
  /** 1-based line of the main cursor (1 when the editor is not mounted). */
  getCursorLine: () => number;
  /**
   * `\include`d chapter the cursor is in (the `\include` on the cursor line or the
   * nearest one above), or `null` when the document has no `\include`.
   */
  getActiveChapter: () => string | null;
}

interface LatexEditorProps {
  ytext: Y.Text;
  awareness: Awareness;
  /** Per-file undo history that outlives this editor instance (tab switches). */
  undoManager?: UndoManager;
  /** Cursor offset to restore when the editor mounts (coming back to a tab). */
  initialAnchor?: number;
  /** 1-based line of the main cursor, on every selection change. */
  onCursorLine?: (line: number) => void;
  /** Cursor offset when the editor unmounts (leaving the tab). */
  onLeave?: (anchor: number) => void;
  theme?: ResolvedTheme;
  /** Project-wide labels, citations and files (smart completion, go to definition). */
  getIndex?: () => ProjectIndex;
  rootFile?: string;
  /** F12 on a \ref / \cite / \input: open where it is defined. */
  onGoToDefinition?: (definition: Definition) => void;
}

/** Monokai Pro highlight style tuned for LaTeX. */
const latexHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--color-mk-red)" },
  { tag: [tags.controlKeyword, tags.definitionKeyword], color: "var(--color-mk-red)" },
  { tag: [tags.function(tags.variableName), tags.macroName], color: "var(--color-mk-green)" },
  { tag: [tags.typeName, tags.className, tags.labelName], color: "var(--color-mk-blue)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--color-mk-yellow)" },
  { tag: tags.comment, color: "var(--color-mk-fg4)", fontStyle: "italic" },
  { tag: [tags.number, tags.atom, tags.bool], color: "var(--color-mk-purple)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--color-mk-orange)" },
  { tag: [tags.bracket, tags.paren, tags.brace], color: "var(--color-mk-fg2)" },
  { tag: tags.heading, color: "var(--color-mk-yellow)", fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.invalid, color: "var(--color-mk-red)", textDecoration: "underline wavy" },
]);

const editorThemeSpec: Parameters<typeof EditorView.theme>[0] = (
  {
    "&": { height: "100%", fontSize: "13.5px", backgroundColor: "var(--color-mk-bg)", color: "var(--color-mk-fg)" },
    ".cm-scroller": {
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', Menlo, Consolas, monospace",
      lineHeight: "1.6",
    },
    ".cm-content": { caretColor: "var(--color-mk-fg)", padding: "10px 0" },
    "&.cm-focused .cm-cursor": { borderLeftColor: "var(--color-mk-fg)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "var(--color-mk-bg4) !important",
    },
    ".cm-activeLine": { backgroundColor: "var(--color-mk-line)" },
    ".cm-gutters": { backgroundColor: "var(--color-mk-bg)", color: "var(--color-mk-bg4)", border: "none", paddingRight: "6px" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--color-mk-fg2)" },
    ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--color-mk-bg4) 50%, transparent)" },
    ".cm-matchingBracket": { backgroundColor: "var(--color-mk-bg4)", outline: "1px solid var(--color-mk-fg3)" },
    ".cm-tooltip": { backgroundColor: "var(--color-mk-bg2)", border: "1px solid var(--color-mk-bg3)", color: "var(--color-mk-fg)" },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "var(--color-mk-bg3)",
      color: "var(--color-mk-fg)",
    },
    ".cm-panels": { backgroundColor: "var(--color-mk-bg2)", color: "var(--color-mk-fg)" },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--color-mk-bg3)" },
    ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--color-mk-yellow) 25%, transparent)", outline: "1px solid color-mix(in srgb, var(--color-mk-yellow) 50%, transparent)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--color-mk-orange) 50%, transparent)" },
    ".cm-panel input, .cm-panel button": {
      backgroundColor: "var(--color-mk-bg)",
      color: "var(--color-mk-fg)",
      border: "1px solid var(--color-mk-bg3)",
      borderRadius: "0",
    },
  }
);

/** Colors come from the app's CSS variables; `dark` only picks CodeMirror's base styles. */
const editorThemes = {
  dark: EditorView.theme(editorThemeSpec, { dark: true }),
  light: EditorView.theme(editorThemeSpec, { dark: false }),
};

const LatexEditor = forwardRef<LatexEditorHandle, LatexEditorProps>(function LatexEditor(
  { ytext, awareness, undoManager, initialAnchor, onCursorLine, onLeave, theme = "dark", getIndex, rootFile, onGoToDefinition },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment());
  const callbacks = useRef({ onCursorLine, onLeave, initialAnchor, getIndex, rootFile, onGoToDefinition, theme });
  callbacks.current = { onCursorLine, onLeave, initialAnchor, getIndex, rootFile, onGoToDefinition, theme };

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
      getCursorLine() {
        const view = viewRef.current;
        if (!view) return 1;
        return view.state.doc.lineAt(view.state.selection.main.head).number;
      },
      getActiveChapter() {
        const view = viewRef.current;
        if (!view) return null;
        const { state } = view;
        return activeChapter(state.doc.toString(), state.doc.lineAt(state.selection.main.head).number);
      },
    }),
    []
  );

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeCompartment.current.reconfigure(editorThemes[theme]) });
  }, [theme]);

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;

    const referenceSource = referenceCompletionSource(
      () => callbacks.current.getIndex?.() ?? null,
      () => callbacks.current.rootFile ?? "main.tex"
    );
    const goToDefinition = (target: EditorView): boolean => {
      const index = callbacks.current.getIndex?.();
      const go = callbacks.current.onGoToDefinition;
      if (!index || !go) return false;
      const head = target.state.selection.main.head;
      const line = target.state.doc.lineAt(head);
      const def = findDefinition(line.text, head - line.from, index, callbacks.current.rootFile ?? "main.tex");
      if (def) go(def);
      return true;
    };

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
        // One completion config: project references first, then LaTeX commands.
        autocompletion({ override: [referenceSource, latexCompletionSource(true)], icons: true }),
        // Open the list as soon as a reference argument starts ("{" or "," typed).
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || !update.transactions.some((tr) => tr.isUserEvent("input.type"))) return;
          let typed = "";
          update.changes.iterChanges((_fa, _ta, _fb, _tb, inserted) => {
            typed = inserted.toString();
          });
          if (typed.startsWith("{") || typed === ",") setTimeout(() => startCompletion(update.view), 0);
        }),
        search({ top: true }),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        keymap.of([
          { key: "F12", run: goToDefinition },
          ...yUndoManagerKeymap,
          ...closeBracketsKeymap,
          ...searchKeymap,
          ...completionKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),
        latex({ enableLinting: false, enableTooltips: false, enableAutocomplete: false }),
        syntaxHighlighting(latexHighlightStyle, { fallback: true }),
        yCollab(ytext, awareness, undoManager ? { undoManager } : undefined),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.docChanged) {
            const { state: st } = update;
            callbacks.current.onCursorLine?.(st.doc.lineAt(st.selection.main.head).number);
          }
        }),
        themeCompartment.current.of(editorThemes[callbacks.current.theme]),
      ],
    });

    const view = new EditorView({ state, parent });
    viewRef.current = view;
    const anchor = callbacks.current.initialAnchor;
    if (anchor !== undefined && anchor > 0) {
      const pos = Math.min(anchor, view.state.doc.length);
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    }
    callbacks.current.onCursorLine?.(view.state.doc.lineAt(view.state.selection.main.head).number);
    view.focus();
    return () => {
      callbacks.current.onLeave?.(view.state.selection.main.head);
      view.destroy();
      viewRef.current = null;
    };
  }, [ytext, awareness, undoManager]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden" />;
});

export default LatexEditor;

// LatexEditor component: CodeMirror 6 with LaTeX syntax highlighting
// and Yjs P2P collaborative editing via y-codemirror.next.

import { useRef, useEffect } from "react";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
} from "@codemirror/language";
import { autocompletion, closeBrackets } from "@codemirror/autocomplete";
import { latex } from "codemirror-lang-latex";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

interface LatexEditorProps {
  initialContent: string;
  ytext?: Y.Text | null;
  awareness?: Awareness | null;
  onChange?: (content: string) => void;
  onCompile?: () => void;
}

export default function LatexEditor({
  initialContent,
  ytext,
  awareness,
  onChange,
  onCompile,
}: LatexEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onCompileRef = useRef(onCompile);
  onCompileRef.current = onCompile;

  useEffect(() => {
    if (!containerRef.current) return;

    const isCollab = Boolean(ytext && awareness);

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && onChange) {
        onChange(update.state.doc.toString());
      }
    });

    const compileKeymap = keymap.of([
      {
        key: "Mod-s",
        run: () => {
          if (onCompileRef.current) {
            onCompileRef.current();
          }
          return true; // prevent default browser save dialog
        },
      },
    ]);

    const extensions = [
      compileKeymap,

      // Core editing features
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),

      // Keymaps: use yUndoManagerKeymap in collab mode, standard history otherwise
      isCollab
        ? keymap.of([...yUndoManagerKeymap, ...defaultKeymap, indentWithTab])
        : [history(), keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab])],

      // LaTeX syntax highlighting
      latex(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),

      // Collaboration extension (Yjs + WebRTC Awareness cursors)
      ...(isCollab && ytext && awareness
        ? [yCollab(ytext, awareness)]
        : []),

      // Dark editor theme
      EditorView.theme(
        {
          "&": {
            height: "100%",
            fontSize: "14px",
          },
          ".cm-scroller": {
            fontFamily:
              "'JetBrains Mono', 'Fira Code', 'Consolas', 'Courier New', monospace",
          },
          ".cm-content": {
            caretColor: "#528bff",
          },
          "&.cm-focused .cm-cursor": {
            borderLeftColor: "#528bff",
          },
          ".cm-gutters": {
            backgroundColor: "#1e1e2e",
            color: "#6c7086",
            borderRight: "1px solid #313244",
          },
          ".cm-activeLineGutter": {
            backgroundColor: "#1e1e2e",
          },
        },
        { dark: true }
      ),

      // Dark base background
      EditorView.baseTheme({
        "&.cm-editor": {
          backgroundColor: "#1e1e2e",
          color: "#cdd6f4",
        },
        ".cm-activeLine": {
          backgroundColor: "#27273a",
        },
      }),

      updateListener,
    ];

    const state = EditorState.create({
      doc: ytext ? ytext.toString() : initialContent,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytext, awareness]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden" />;
}

// LatexEditor component: CodeMirror 6 with LaTeX syntax highlighting
// Handles Mod-s (Cmd+S / Ctrl+S) for compiling.

import { useRef, useEffect } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from "@codemirror/language";
import { autocompletion, closeBrackets } from "@codemirror/autocomplete";
import { latex } from "codemirror-lang-latex";

interface LatexEditorProps {
  initialContent: string;
  onChange?: (content: string) => void;
  onCompile?: () => void;
}

export default function LatexEditor({ initialContent, onChange, onCompile }: LatexEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onCompileRef = useRef(onCompile);
  onCompileRef.current = onCompile;

  useEffect(() => {
    if (!containerRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && onChange) {
        onChange(update.state.doc.toString());
      }
    });

    const state = EditorState.create({
      doc: initialContent,
      extensions: [
        // Keymap intercepting Mod-s (Cmd-S on Mac, Ctrl-S on Windows/Linux)
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              if (onCompileRef.current) {
                onCompileRef.current();
              }
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),

        // Core editing features
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),

        // LaTeX syntax highlighting
        latex(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),

        // Theme
        EditorView.theme({
          "&": {
            height: "100%",
            fontSize: "14px",
          },
          ".cm-scroller": {
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
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
        }, { dark: true }),

        // Dark base theme
        EditorView.baseTheme({
          "&.cm-editor": {
            backgroundColor: "#1e1e2e",
            color: "#cdd6f4",
          },
          ".cm-activeLine": {
            backgroundColor: "#27273a",
          },
        }),

        // Listen for changes
        updateListener,
      ],
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
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden"
    />
  );
}

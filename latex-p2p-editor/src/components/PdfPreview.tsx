// PdfPreview: pdf.js based viewer plus compiler diagnostics.
//
// Compared with an <iframe>, rendering through pdf.js lets the preview keep
// its scroll position and zoom across recompiles (the behaviour LaTeX users
// expect from Overleaf) and lets the app control zoom and page rendering.
// Pages are rendered lazily, so a 300-page thesis only rasterises what is on
// screen.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  FileText,
  Loader2,
  Maximize2,
  Terminal,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { LatexDiagnostic } from "../services/latexLog";
import { useI18n } from "../i18n";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface CompileSummary {
  success: boolean;
  compiler: string;
  durationMs: number;
  timedOut: boolean;
}

interface PdfPreviewProps {
  /** Raw PDF bytes of the last successful render; `null` before the first compile. */
  pdfData: Uint8Array | null;
  /** Increments on every new `pdfData` so identical bytes still trigger a reload. */
  pdfVersion: number;
  logs: string | null;
  diagnostics: LatexDiagnostic[];
  summary: CompileSummary | null;
  /** Infrastructure error (no compiler, IPC failure…), distinct from LaTeX errors. */
  fatalError: string | null;
  isCompiling: boolean;
  /** Hide the "compiling" overlay (automatic background builds). */
  quietCompile?: boolean;
  canExport: boolean;
  mainFile: string | null;
  onJumpToLine: (line: number) => void;
  onExport: () => void;
  onPageCount?: (count: number | null) => void;
}

type ZoomMode = { kind: "fit" } | { kind: "manual"; scale: number };

const MIN_SCALE = 0.4;
const MAX_SCALE = 4;
const ZOOM_STEP = 1.2;

interface PageDims {
  width: number;
  height: number;
}

export default function PdfPreview({
  pdfData,
  pdfVersion,
  logs,
  diagnostics,
  summary,
  fatalError,
  isCompiling,
  quietCompile = false,
  canExport,
  mainFile,
  onJumpToLine,
  onExport,
  onPageCount,
}: PdfPreviewProps) {
  const { t } = useI18n();
  const [showLogs, setShowLogs] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(true);
  const [zoom, setZoom] = useState<ZoomMode>({ kind: "fit" });
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageDims, setPageDims] = useState<PageDims[]>([]);
  const [containerWidth, setContainerWidth] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const renderTasks = useRef<Map<number, RenderTask>>(new Map());
  const renderedAt = useRef<Map<number, number>>(new Map()); // page → scale rendered
  const scrollRatioRef = useRef<number | null>(null);

  // ─── Load document ──────────────────────────────────────────────
  useEffect(() => {
    if (!pdfData) {
      setDoc(null);
      setPageDims([]);
      return;
    }
    let cancelled = false;
    const container = scrollRef.current;
    if (container && container.scrollHeight > 0) {
      scrollRatioRef.current = container.scrollTop / container.scrollHeight;
    }
    // pdf.js transfers the buffer to the worker: hand it a copy.
    const task = pdfjsLib.getDocument({ data: pdfData.slice() });
    task.promise
      .then(async (loaded) => {
        if (cancelled) {
          await loaded.loadingTask.destroy();
          return;
        }
        const dims: PageDims[] = [];
        for (let i = 1; i <= loaded.numPages; i++) {
          const page = await loaded.getPage(i);
          const viewport = page.getViewport({ scale: 1 });
          dims.push({ width: viewport.width, height: viewport.height });
        }
        if (cancelled) {
          await loaded.loadingTask.destroy();
          return;
        }
        renderedAt.current.clear();
        setPageDims(dims);
        setDoc((previous) => {
          void previous?.loadingTask.destroy();
          return loaded;
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) console.error("PdfPreview: failed to load PDF:", err);
      });
    return () => {
      cancelled = true;
      task.destroy().catch(() => undefined);
    };
  }, [pdfData, pdfVersion]);

  useEffect(() => () => void doc?.loadingTask.destroy(), [doc]);
  useEffect(() => {
    onPageCount?.(doc ? doc.numPages : null);
  }, [doc, onPageCount]);

  // ─── Track container width for fit-to-width ─────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setContainerWidth(width);
    });
    observer.observe(el);
    setContainerWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const scale = useMemo(() => {
    if (zoom.kind === "manual") return zoom.scale;
    const pageWidth = pageDims[0]?.width ?? 612;
    const available = Math.max(containerWidth - 32, 100);
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, available / pageWidth));
  }, [zoom, pageDims, containerWidth]);

  // ─── Lazy page rendering ────────────────────────────────────────
  const renderPage = useCallback(
    async (pageNumber: number) => {
      const current = doc;
      const holder = pageRefs.current.get(pageNumber);
      if (!current || !holder) return;
      if (renderedAt.current.get(pageNumber) === scale) return;
      renderTasks.current.get(pageNumber)?.cancel();

      try {
        const page = await current.getPage(pageNumber);
        if (doc !== current) return;
        const viewport = page.getViewport({ scale });
        const dpr = window.devicePixelRatio || 1;
        let canvas = holder.querySelector("canvas");
        if (!canvas) {
          canvas = document.createElement("canvas");
          holder.appendChild(canvas);
        }
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const task = page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        renderTasks.current.set(pageNumber, task);
        await task.promise;
        renderedAt.current.set(pageNumber, scale);
      } catch (err: unknown) {
        const name = (err as { name?: string })?.name;
        if (name !== "RenderingCancelledException") {
          console.error(`PdfPreview: render of page ${pageNumber} failed:`, err);
        }
      } finally {
        renderTasks.current.delete(pageNumber);
      }
    },
    [doc, scale]
  );

  useEffect(() => {
    const container = scrollRef.current;
    if (!doc || !container) return;
    renderedAt.current.clear();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const n = Number((entry.target as HTMLElement).dataset.page);
            void renderPage(n);
          }
        }
      },
      { root: container, rootMargin: "800px 0px" }
    );
    pageRefs.current.forEach((el) => observer.observe(el));

    // Restore the scroll position captured before the reload.
    if (scrollRatioRef.current !== null) {
      const ratio = scrollRatioRef.current;
      scrollRatioRef.current = null;
      requestAnimationFrame(() => {
        container.scrollTop = ratio * container.scrollHeight;
      });
    }
    return () => observer.disconnect();
  }, [doc, renderPage, pageDims.length]);

  const setPageRef = useCallback((pageNumber: number, el: HTMLDivElement | null) => {
    if (el) pageRefs.current.set(pageNumber, el);
    else pageRefs.current.delete(pageNumber);
  }, []);

  const zoomBy = (factor: number) =>
    setZoom({ kind: "manual", scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor)) });

  // ─── Derived UI state ───────────────────────────────────────────
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");
  const hasDrawer = Boolean(logs || fatalError);
  const canJump = (d: LatexDiagnostic) =>
    d.line !== undefined && (d.file === undefined || d.file === mainFile || `./${d.file}` === mainFile);

  return (
    <div className="h-full flex flex-col bg-mk-bg relative overflow-hidden">
      {/* Viewer toolbar */}
      <div className="flex items-center gap-1 h-8 px-2 border-b border-mk-bg3 bg-mk-bg2 text-[11px] text-mk-fg3 select-none shrink-0">
        <button
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          disabled={!doc}
          className="p-1.5 hover:bg-mk-bg3 hover:text-mk-fg disabled:opacity-40 cursor-pointer"
          title={t("preview.zoomOut")}
        >
          <ZoomOut size={14} />
        </button>
        <span className="w-12 text-center font-mono text-mk-fg2">{Math.round(scale * 100)}%</span>
        <button
          onClick={() => zoomBy(ZOOM_STEP)}
          disabled={!doc}
          className="p-1.5 hover:bg-mk-bg3 hover:text-mk-fg disabled:opacity-40 cursor-pointer"
          title={t("preview.zoomIn")}
        >
          <ZoomIn size={14} />
        </button>
        <button
          onClick={() => setZoom({ kind: "fit" })}
          disabled={!doc || zoom.kind === "fit"}
          className="p-1.5 hover:bg-mk-bg3 hover:text-mk-fg disabled:opacity-40 cursor-pointer"
          title={t("preview.fitWidth")}
        >
          <Maximize2 size={14} />
        </button>
        {doc && <span className="ml-2 text-mk-fg4">{doc.numPages === 1 ? t("preview.page") : t("preview.pages", { count: doc.numPages })}</span>}
        <div className="flex-1" />
        {summary && !isCompiling && (
          <span className="text-mk-fg4">
            {t("preview.compiledWith", { compiler: summary.compiler, seconds: (summary.durationMs / 1000).toFixed(1) })}
          </span>
        )}
        <button
          onClick={onExport}
          disabled={!canExport}
          className="flex items-center gap-1 px-2 py-1 hover:bg-mk-bg3 disabled:opacity-40 text-mk-fg2 hover:text-mk-fg cursor-pointer"
          title={t("preview.export.tip")}
        >
          <Download size={13} />
          <span>{t("preview.export")}</span>
        </button>
      </div>

      {/* Loading overlay during compilation */}
      {isCompiling && !quietCompile && (
        <div className="absolute inset-x-0 top-8 z-20 flex justify-center pointer-events-none">
          <div className="mt-3 flex items-center gap-2 px-3 py-1.5 bg-mk-bg2/95 border border-mk-bg3 text-xs text-mk-fg2 shadow-lg">
            <Loader2 size={14} className="animate-spin text-mk-yellow" />
            {t("preview.compiling")}
          </div>
        </div>
      )}

      {/* Pages */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto bg-[#1e1c1f]">
        {doc && pageDims.length > 0 ? (
          <div className="flex flex-col items-center gap-4 py-4">
            {pageDims.map((dims, index) => {
              const pageNumber = index + 1;
              return (
                <div
                  key={`${pdfVersion}-${pageNumber}`}
                  ref={(el) => setPageRef(pageNumber, el)}
                  data-page={pageNumber}
                  className="bg-white shadow-lg shadow-black/50"
                  style={{ width: Math.floor(dims.width * scale), height: Math.floor(dims.height * scale) }}
                />
              );
            })}
          </div>
        ) : fatalError ? (
          <div className="h-full flex flex-col items-center justify-center p-6 text-center">
            <AlertCircle size={40} className="text-mk-red mb-2" strokeWidth={1.5} />
            <h3 className="text-sm font-semibold text-mk-fg mb-1">{t("preview.fatal.title")}</h3>
            <p className="text-xs text-mk-fg3 max-w-md whitespace-pre-wrap">{fatalError}</p>
          </div>
        ) : summary && !summary.success ? (
          <div className="h-full flex flex-col items-center justify-center p-6 text-center">
            <AlertCircle size={40} className="text-mk-red mb-2" strokeWidth={1.5} />
            <h3 className="text-sm font-semibold text-mk-fg mb-1">{t("preview.error.title")}</h3>
            <p className="text-xs text-mk-fg3 max-w-md">{t("preview.error.body")}</p>
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-mk-fg4 gap-3 select-none">
            <FileText size={48} strokeWidth={1} />
            <p className="text-sm">
              {t("preview.idle.before")}{" "}
              <kbd className="px-1.5 py-0.5 bg-mk-bg2 text-mk-fg2 border border-mk-bg3 text-xs font-mono">⌘S</kbd>{" "}
              {t("preview.idle.after")}
            </p>
          </div>
        )}
      </div>

      {/* Diagnostics + logs drawer */}
      {hasDrawer && (
        <div className="border-t border-mk-bg3 bg-mk-bg2 flex flex-col max-h-[45%] shrink-0">
          <div className="flex items-center text-xs text-mk-fg3 border-b border-mk-bg3 select-none">
            <button
              onClick={() => setShowDiagnostics((v) => !v)}
              className="flex items-center gap-2 px-3 py-1.5 hover:text-mk-fg hover:bg-mk-bg3/50 cursor-pointer flex-1 text-left"
            >
              {fatalError || (summary && !summary.success) ? (
                <span className="flex items-center gap-1 text-mk-red">
                  <AlertCircle size={12} />{" "}
                  {errors.length === 0 ? t("preview.status.error") : errors.length === 1 ? t("preview.status.error1") : t("preview.status.errors", { count: errors.length })}
                </span>
              ) : (
                <span className="flex items-center gap-1 text-mk-green">
                  <CheckCircle2 size={12} /> {t("preview.status.ok")}
                </span>
              )}
              {warnings.length > 0 && (
                <span className="flex items-center gap-1 text-mk-orange">
                  <AlertTriangle size={12} />{" "}
                  {warnings.length === 1 ? t("preview.status.warning1") : t("preview.status.warnings", { count: warnings.length })}
                </span>
              )}
              {summary?.timedOut && <span className="text-mk-red">{t("preview.status.timeout")}</span>}
              <span className="ml-auto text-mk-fg4">{showDiagnostics ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</span>
            </button>
            <button
              onClick={() => setShowLogs((v) => !v)}
              className={`flex items-center gap-1 px-3 py-1.5 border-l border-mk-bg3 hover:text-mk-fg hover:bg-mk-bg3/50 cursor-pointer ${showLogs ? "text-mk-fg" : ""}`}
              title={t("preview.log.tip")}
            >
              <Terminal size={13} /> {t("preview.log")}
            </button>
          </div>

          {showDiagnostics && diagnostics.length > 0 && !showLogs && (
            <ul className="overflow-auto text-xs divide-y divide-mk-bg3/60">
              {diagnostics.map((d, i) => {
                const jumpable = canJump(d);
                return (
                  <li key={i}>
                    <button
                      onClick={() => jumpable && d.line !== undefined && onJumpToLine(d.line)}
                      disabled={!jumpable}
                      className={`w-full flex items-start gap-2 px-3 py-1.5 text-left ${
                        jumpable ? "hover:bg-mk-bg3/50 cursor-pointer" : "cursor-default"
                      }`}
                      title={jumpable ? t("preview.jump") : undefined}
                    >
                      {d.severity === "error" ? (
                        <AlertCircle size={13} className="text-mk-red mt-0.5 shrink-0" />
                      ) : (
                        <AlertTriangle size={13} className="text-mk-orange mt-0.5 shrink-0" />
                      )}
                      <span className="font-mono text-mk-fg4 shrink-0 w-24 truncate">
                        {d.file ? `${d.file}` : ""}
                        {d.line !== undefined ? `:${d.line}` : ""}
                      </span>
                      <span className="text-mk-fg2 break-words">{d.message}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {(showLogs || (showDiagnostics && diagnostics.length === 0 && (fatalError || (summary && !summary.success)))) && (
            <div className="overflow-auto p-3 font-mono text-[11px] text-mk-fg2 bg-mk-bg select-text max-h-64">
              <pre className="whitespace-pre-wrap leading-relaxed">{fatalError ?? logs}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

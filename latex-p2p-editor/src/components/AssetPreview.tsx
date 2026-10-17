// Read-only preview of a binary project file opened from the tree: images
// render directly, PDFs (figures, attached papers) through pdf.js. Shown in the
// editor area instead of the text editor.

import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { Loader2 } from "lucide-react";
import { useI18n } from "../i18n";
import { readProjectFileBytes } from "../services/tauriBridge";

interface AssetPreviewProps {
  projectPath: string;
  path: string;
  /** Bumped to reload (the file changed on disk). */
  version?: number;
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  bmp: "image/bmp",
};

/** At most this many PDF pages are rasterised (figures rarely have more). */
const MAX_PDF_PAGES = 30;

export default function AssetPreview({ projectPath, path, version = 0 }: AssetPreviewProps) {
  const { t } = useI18n();
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<string | null>(null);
  const pagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);
    setInfo(null);
    setLoading(true);
    const pagesEl = pagesRef.current;
    if (pagesEl) pagesEl.replaceChildren();

    readProjectFileBytes(projectPath, path)
      .then(async (bytes) => {
        if (cancelled) return;
        const kb = Math.max(1, Math.round(bytes.byteLength / 1024));
        if (ext === "pdf") {
          const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
          try {
            const count = Math.min(doc.numPages, MAX_PDF_PAGES);
            setInfo(t("preview.asset.pdfInfo", { pages: doc.numPages, kb }));
            for (let i = 1; i <= count && !cancelled; i++) {
              const page = await doc.getPage(i);
              const viewport = page.getViewport({ scale: 1.5 });
              const canvas = document.createElement("canvas");
              canvas.width = viewport.width;
              canvas.height = viewport.height;
              canvas.className = "max-w-full h-auto shadow-lg bg-white";
              const ctx = canvas.getContext("2d");
              if (!ctx) continue;
              await page.render({ canvasContext: ctx, viewport, canvas }).promise;
              if (!cancelled) pagesRef.current?.appendChild(canvas);
            }
          } finally {
            void doc.loadingTask.destroy();
          }
        } else {
          const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: MIME[ext] ?? "application/octet-stream" });
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
          setInfo(t("preview.asset.imageInfo", { kb }));
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(typeof err === "string" ? err : err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectPath, path, ext, version, t]);

  return (
    <div className="h-full flex flex-col bg-mk-bg">
      <div className="h-7 shrink-0 flex items-center gap-2 px-3 text-[11px] text-mk-fg3 border-b border-mk-bg3">
        <span className="font-mono text-mk-fg2">{path}</span>
        {info && <span className="text-mk-fg4">· {info}</span>}
        <span className="ml-auto text-mk-fg4">{t("preview.asset.readOnly")}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-6 flex flex-col items-center gap-4 bg-mk-canvas">
        {loading && <Loader2 size={18} className="animate-spin text-mk-fg3" />}
        {error && <div className="text-mk-red text-xs">{t("preview.asset.error", { message: error })}</div>}
        {url && (
          <img
            src={url}
            alt={path}
            className="max-w-full h-auto object-contain"
            style={{ backgroundImage: "repeating-conic-gradient(var(--color-mk-bg) 0 25%, var(--color-mk-bg3) 0 50%)", backgroundSize: "16px 16px" }}
          />
        )}
        <div ref={pagesRef} className="flex flex-col items-center gap-4 w-full" />
      </div>
    </div>
  );
}

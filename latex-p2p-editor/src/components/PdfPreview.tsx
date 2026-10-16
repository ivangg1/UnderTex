// PdfPreview component: Renders compiled PDF bytes and compilation logs

import { useState } from "react";
import { FileText, Loader2, Terminal, AlertCircle, CheckCircle2, ChevronDown, ChevronUp } from "lucide-react";

interface PdfPreviewProps {
  pdfUrl: string | null;
  logs: string | null;
  isCompiling: boolean;
  compileError: string | null;
}

export default function PdfPreview({
  pdfUrl,
  logs,
  isCompiling,
  compileError,
}: PdfPreviewProps) {
  const [showLogs, setShowLogs] = useState(false);

  // If there's an error and no PDF, show logs by default so user sees what went wrong
  const effectiveShowLogs = showLogs || (Boolean(compileError) && !pdfUrl);

  return (
    <div className="h-full flex flex-col bg-gray-900 relative overflow-hidden">
      {/* Loading overlay during compilation */}
      {isCompiling && (
        <div className="absolute inset-0 bg-gray-950/70 z-20 flex flex-col items-center justify-center gap-3 backdrop-blur-xs">
          <Loader2 size={36} className="animate-spin text-green-400" />
          <p className="text-sm font-medium text-gray-200">
            Compiling LaTeX locally…
          </p>
        </div>
      )}

      {/* Main Preview Area */}
      <div className="flex-1 min-h-0 relative">
        {pdfUrl ? (
          <iframe
            src={pdfUrl}
            className="w-full h-full border-none bg-white"
            title="PDF Preview"
          />
        ) : compileError ? (
          <div className="h-full flex flex-col items-center justify-center p-6 text-center">
            <AlertCircle size={44} className="text-red-400 mb-2" />
            <h3 className="text-base font-semibold text-red-200 mb-1">
              Compilation Error
            </h3>
            <p className="text-xs text-gray-400 max-w-md mb-4">
              TeX failed to generate a PDF. Check the logs below for compiler details.
            </p>
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-gray-500 gap-3 select-none">
            <FileText size={48} strokeWidth={1} />
            <p className="text-sm">Click "Compile" or press <kbd className="px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded border border-gray-700 text-xs">⌘S</kbd> to preview PDF</p>
          </div>
        )}
      </div>

      {/* Bottom Logs Drawer */}
      {(logs || compileError) && (
        <div className="border-t border-gray-800 bg-gray-950 flex flex-col transition-all duration-150">
          {/* Header / Toggle button */}
          <button
            onClick={() => setShowLogs((prev) => !prev)}
            className="flex items-center justify-between px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-900 border-b border-gray-850 cursor-pointer select-none"
          >
            <div className="flex items-center gap-1.5 font-medium">
              <Terminal size={14} />
              <span>Compilation Logs</span>
              {compileError ? (
                <span className="flex items-center gap-1 text-red-400 text-[11px] ml-2">
                  <AlertCircle size={12} /> Error
                </span>
              ) : (
                <span className="flex items-center gap-1 text-green-400 text-[11px] ml-2">
                  <CheckCircle2 size={12} /> Success
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 text-gray-500">
              {effectiveShowLogs ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </div>
          </button>

          {/* Collapsible log output */}
          {effectiveShowLogs && (
            <div className="h-44 overflow-auto p-3 font-mono text-xs text-gray-300 bg-black/50 select-text">
              <pre className="whitespace-pre-wrap leading-relaxed">
                {compileError || logs}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

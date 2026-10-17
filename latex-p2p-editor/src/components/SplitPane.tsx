// Horizontal split with a draggable divider. The ratio is remembered per user.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

const STORAGE_KEY = "latex_split_ratio";
const MIN_RATIO = 0.25;
const MAX_RATIO = 0.75;

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
}

function readRatio(): number {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    if (value >= MIN_RATIO && value <= MAX_RATIO) return value;
  } catch {
    // ignore
  }
  return 0.5;
}

export default function SplitPane({ left, right }: SplitPaneProps) {
  const [ratio, setRatio] = useState(readRatio);
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const next = Math.min(MAX_RATIO, Math.max(MIN_RATIO, (e.clientX - rect.left) / rect.width));
      setRatio(next);
    };
    const onUp = () => {
      setDragging(false);
      setRatio((r) => {
        try {
          localStorage.setItem(STORAGE_KEY, String(r));
        } catch {
          // ignore
        }
        return r;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging]);

  return (
    <div ref={containerRef} className={`flex-1 flex min-h-0 ${dragging ? "select-none cursor-col-resize" : ""}`}>
      <div className="min-h-0 min-w-0" style={{ width: `${ratio * 100}%` }}>
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onPointerDown}
        className={`w-1 shrink-0 cursor-col-resize bg-mk-bg3 hover:bg-mk-yellow transition-colors ${
          dragging ? "bg-mk-yellow" : ""
        }`}
      />
      <div className="flex-1 min-h-0 min-w-0">{right}</div>
    </div>
  );
}

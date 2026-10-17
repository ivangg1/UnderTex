import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Crown,
  Edit3,
  File,
  FileCode,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  PanelLeftClose,
  Sliders,
  Trash2,
  X,
} from "lucide-react";
import type { ProjectNode } from "../services/tauriBridge";
import { useI18n } from "../i18n";

export type FileType = "tex" | "bib" | "style" | "image" | "text" | "other";

export function getFileType(name: string): FileType {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "tex") return "tex";
  if (ext === "bib") return "bib";
  if (ext === "sty" || ext === "cls") return "style";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "pdf", "bmp"].includes(ext || "")) return "image";
  if (["txt", "md", "markdown", "json", "yaml", "yml", "xml", "csv", "latexmkrc"].includes(ext || "")) return "text";
  return "other";
}

export function isEditableFile(name: string): boolean {
  const type = getFileType(name);
  return type === "tex" || type === "bib" || type === "style" || type === "text";
}

export function getFileIcon(name: string): ReactNode {
  const type = getFileType(name);
  switch (type) {
    case "tex":
      return <FileText size={14} className="text-mk-yellow shrink-0" />;
    case "bib":
      return <BookOpen size={14} className="text-mk-orange shrink-0" />;
    case "style":
      return <Sliders size={14} className="text-mk-purple shrink-0" />;
    case "image":
      return <ImageIcon size={14} className="text-mk-green shrink-0" />;
    case "text":
      return <FileCode size={14} className="text-mk-blue shrink-0" />;
    default:
      return <File size={14} className="text-mk-fg3 shrink-0" />;
  }
}

export interface FileTreeProps {
  nodes: ProjectNode[];
  activeFile: string | null;
  rootFile: string | null;
  onSelectFile: (path: string) => void;
  onSetRootFile?: (path: string) => void;
  onCreateNode: (relPath: string, isDir: boolean) => Promise<void>;
  onRenameNode: (oldRelPath: string, newRelPath: string) => Promise<void>;
  onDeleteNode: (relPath: string) => Promise<void>;
  onToggleCollapse: () => void;
}

interface CreatingState {
  isDir: boolean;
  parentDir: string; // "" for root, or "chapters" etc.
}

interface RenamingState {
  oldRelPath: string;
  name: string;
}

export default function FileTree({
  nodes,
  activeFile,
  rootFile,
  onSelectFile,
  onSetRootFile,
  onCreateNode,
  onRenameNode,
  onDeleteNode,
  onToggleCollapse,
}: FileTreeProps) {
  const { t } = useI18n();

  // Collapsed directory set
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());

  // Creating file/folder state
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [createInput, setCreateInput] = useState("");
  const createInputRef = useRef<HTMLInputElement>(null);

  // Renaming state
  const [renaming, setRenaming] = useState<RenamingState | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Deleting confirmation state
  const [deletingPath, setDeletingPath] = useState<string | null>(null);

  useEffect(() => {
    if (creating && createInputRef.current) {
      createInputRef.current.focus();
    }
  }, [creating]);

  useEffect(() => {
    if (renaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renaming]);

  const toggleDir = useCallback((dirPath: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }, []);

  const handleStartCreate = (isDir: boolean, parentDir = "") => {
    setCreating({ isDir, parentDir });
    setCreateInput(isDir ? "new_folder" : "new_file.tex");
  };

  const handleConfirmCreate = async () => {
    if (!creating) return;
    const name = createInput.trim();
    if (!name) {
      setCreating(null);
      return;
    }
    const relPath = creating.parentDir ? `${creating.parentDir}/${name}` : name;
    try {
      await onCreateNode(relPath, creating.isDir);
      setCreating(null);
      setCreateInput("");
    } catch {
      // handled by parent banner
    }
  };

  const handleStartRename = (node: ProjectNode) => {
    setRenaming({ oldRelPath: node.path, name: node.name });
  };

  const handleConfirmRename = async () => {
    if (!renaming) return;
    const newName = renaming.name.trim();
    if (!newName) {
      setRenaming(null);
      return;
    }
    const parts = renaming.oldRelPath.split("/");
    parts.pop();
    const newRelPath = parts.length > 0 ? `${parts.join("/")}/${newName}` : newName;
    if (newRelPath === renaming.oldRelPath) {
      setRenaming(null);
      return;
    }
    try {
      await onRenameNode(renaming.oldRelPath, newRelPath);
      setRenaming(null);
    } catch {
      // handled by parent banner
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingPath) return;
    const target = deletingPath;
    setDeletingPath(null);
    try {
      await onDeleteNode(target);
    } catch {
      // handled by parent banner
    }
  };

  const renderTree = (items: ProjectNode[], depth = 0): ReactNode => {
    return items.map((node) => {
      const isDir = node.is_dir;
      const isCollapsed = collapsedDirs.has(node.path);
      const isActive = !isDir && activeFile === node.path;
      const isRoot = !isDir && rootFile === node.path;
      const isRenamingThis = renaming?.oldRelPath === node.path;

      if (isRenamingThis) {
        return (
          <div
            key={node.path}
            className="flex items-center gap-1.5 px-2 py-1 bg-mk-bg3 border-l-2 border-mk-yellow text-xs"
            style={{ paddingLeft: `${depth * 14 + 10}px` }}
          >
            {isDir ? <Folder size={14} className="text-mk-fg2 shrink-0" /> : getFileIcon(node.name)}
            <input
              ref={renameInputRef}
              type="text"
              value={renaming.name}
              onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleConfirmRename();
                if (e.key === "Escape") setRenaming(null);
              }}
              className="flex-1 min-w-0 bg-mk-bg text-mk-fg px-1.5 py-0.5 rounded text-[11px] font-mono outline-none border border-mk-yellow"
            />
            <button
              onClick={() => void handleConfirmRename()}
              className="p-1 hover:text-mk-green cursor-pointer text-mk-fg3"
              title={t("files.create")}
            >
              <Check size={12} />
            </button>
            <button
              onClick={() => setRenaming(null)}
              className="p-1 hover:text-mk-red cursor-pointer text-mk-fg3"
              title={t("files.cancel")}
            >
              <X size={12} />
            </button>
          </div>
        );
      }

      return (
        <div key={node.path} className="flex flex-col">
          <div
            className={`group relative flex items-center gap-1.5 px-2 py-1.5 text-xs select-none cursor-pointer transition-colors ${
              isActive
                ? "bg-mk-bg text-mk-fg font-medium"
                : "text-mk-fg2 hover:bg-mk-bg3/60 hover:text-mk-fg"
            }`}
            style={{ paddingLeft: `${depth * 14 + 10}px` }}
            onClick={() => {
              if (isDir) toggleDir(node.path);
              else onSelectFile(node.path);
            }}
          >
            {/* Active indicator bar */}
            {isActive && <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-mk-yellow" />}

            {/* Folder chevron / file icon */}
            {isDir ? (
              <span className="flex items-center gap-1 shrink-0 text-mk-fg3 group-hover:text-mk-fg2">
                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                {isCollapsed ? <Folder size={14} className="text-mk-yellow/80" /> : <FolderOpen size={14} className="text-mk-yellow" />}
              </span>
            ) : (
              getFileIcon(node.name)
            )}

            {/* Filename */}
            <span className="truncate flex-1 font-mono text-[11px]">{node.name}</span>

            {/* Root / Main file badge */}
            {isRoot && (
              <span
                className="shrink-0 px-1 py-0.2 rounded text-[9px] font-mono font-semibold bg-mk-yellow/20 text-mk-yellow border border-mk-yellow/40 flex items-center gap-0.5"
                title={t("files.mainBadge")}
              >
                <Crown size={9} />
                <span>{t("files.mainBadge")}</span>
              </span>
            )}

            {/* Action buttons (hover) */}
            <div className="hidden group-hover:flex items-center gap-1 shrink-0 bg-mk-bg2/90 pl-1">
              {!isDir && node.name.toLowerCase().endsWith(".tex") && !isRoot && onSetRootFile && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSetRootFile(node.path);
                  }}
                  className="p-1 text-mk-fg3 hover:text-mk-yellow cursor-pointer rounded"
                  title={t("files.setMain")}
                >
                  <Crown size={12} />
                </button>
              )}
              {isDir && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isCollapsed) toggleDir(node.path);
                    handleStartCreate(false, node.path);
                  }}
                  className="p-1 text-mk-fg3 hover:text-mk-fg cursor-pointer rounded"
                  title={t("files.newFile")}
                >
                  <FilePlus size={12} />
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleStartRename(node);
                }}
                className="p-1 text-mk-fg3 hover:text-mk-fg cursor-pointer rounded"
                title={t("files.rename")}
              >
                <Edit3 size={12} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setDeletingPath(node.path);
                }}
                className="p-1 text-mk-fg3 hover:text-mk-red cursor-pointer rounded"
                title={t("files.delete")}
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>

          {/* Directory children */}
          {isDir && !isCollapsed && node.children && node.children.length > 0 && (
            <div className="flex flex-col">{renderTree(node.children, depth + 1)}</div>
          )}
        </div>
      );
    });
  };

  return (
    <aside
      aria-label={t("files.title")}
      className="w-60 shrink-0 flex flex-col bg-mk-bg2 border-r border-mk-bg3 select-none text-xs"
    >
      {/* Header */}
      <div className="h-9 shrink-0 flex items-center justify-between px-3 border-b border-mk-bg3 bg-mk-bg2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-mk-fg3">
          {t("files.title")}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => handleStartCreate(false)}
            className="p-1.5 text-mk-fg3 hover:text-mk-fg hover:bg-mk-bg3 rounded cursor-pointer transition-colors"
            title={t("files.newFile")}
          >
            <FilePlus size={14} />
          </button>
          <button
            onClick={() => handleStartCreate(true)}
            className="p-1.5 text-mk-fg3 hover:text-mk-fg hover:bg-mk-bg3 rounded cursor-pointer transition-colors"
            title={t("files.newFolder")}
          >
            <FolderPlus size={14} />
          </button>
          <button
            onClick={onToggleCollapse}
            className="p-1.5 text-mk-fg3 hover:text-mk-fg hover:bg-mk-bg3 rounded cursor-pointer transition-colors ml-1"
            title={t("files.togglePanel")}
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
      </div>

      {/* Inline Create Input */}
      {creating && (
        <div className="p-2 border-b border-mk-bg3 bg-mk-bg flex items-center gap-1.5">
          {creating.isDir ? (
            <Folder size={14} className="text-mk-yellow shrink-0" />
          ) : (
            <FileText size={14} className="text-mk-fg2 shrink-0" />
          )}
          <input
            ref={createInputRef}
            type="text"
            value={createInput}
            onChange={(e) => setCreateInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleConfirmCreate();
              if (e.key === "Escape") setCreating(null);
            }}
            placeholder={t("files.inputPlaceholder")}
            className="flex-1 min-w-0 bg-mk-bg2 text-mk-fg px-1.5 py-0.5 rounded text-[11px] font-mono outline-none border border-mk-bg4 focus:border-mk-yellow"
          />
          <button
            onClick={() => void handleConfirmCreate()}
            className="p-1 text-mk-fg3 hover:text-mk-green cursor-pointer"
            title={t("files.create")}
          >
            <Check size={13} />
          </button>
          <button
            onClick={() => setCreating(null)}
            className="p-1 text-mk-fg3 hover:text-mk-red cursor-pointer"
            title={t("files.cancel")}
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Tree Content */}
      <div className="flex-1 overflow-y-auto py-1">
        {nodes.length === 0 ? (
          <div className="p-4 text-center text-mk-fg4 italic">{t("files.empty")}</div>
        ) : (
          renderTree(nodes)
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {deletingPath && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-80 bg-mk-bg2 border border-mk-bg3 rounded shadow-2xl p-4 text-xs">
            <h3 className="text-sm font-semibold text-mk-fg mb-2">{t("files.delete")}</h3>
            <p className="text-mk-fg3 mb-4">
              {t("files.deleteConfirm", { name: deletingPath.split("/").pop() ?? deletingPath })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeletingPath(null)}
                className="px-3 py-1 rounded bg-mk-bg3 hover:bg-mk-bg4 text-mk-fg cursor-pointer transition-colors"
              >
                {t("files.cancel")}
              </button>
              <button
                onClick={() => void handleConfirmDelete()}
                className="px-3 py-1 rounded bg-mk-red hover:bg-mk-red/80 text-white font-medium cursor-pointer transition-colors"
              >
                {t("files.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

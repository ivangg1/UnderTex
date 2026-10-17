// Project file tree (Files view of the side panel): folders and files with
// per-type icons, the root file marked, peers' presence, inline create /
// rename / delete and "set as main file". Text files open in the editor,
// images and PDFs in a preview. Files that only exist in the room (shared by a
// peer, not in this folder) are shown in italics.

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
  Sliders,
  Trash2,
  X,
} from "lucide-react";
import type { TreeNode } from "../services/projectFiles";
import type { PeerInfo } from "../services/collabManager";
import { useI18n } from "../i18n";

export type FileType = "tex" | "bib" | "style" | "image" | "pdf" | "text" | "other";

export function getFileType(name: string): FileType {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "tex") return "tex";
  if (ext === "bib") return "bib";
  if (ext === "sty" || ext === "cls") return "style";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"].includes(ext || "")) return "image";
  if (["txt", "md", "markdown", "json", "yaml", "yml", "xml", "csv", "latexmkrc"].includes(ext || "")) return "text";
  return "other";
}

export function isEditableFile(name: string): boolean {
  const type = getFileType(name);
  return type === "tex" || type === "bib" || type === "style" || type === "text";
}

/** Binary files the app can show (images, PDFs). */
export function isPreviewableFile(name: string): boolean {
  const type = getFileType(name);
  return type === "image" || type === "pdf";
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
    case "pdf":
      return <FileText size={14} className="text-mk-red shrink-0" />;
    case "text":
      return <FileCode size={14} className="text-mk-blue shrink-0" />;
    default:
      return <File size={14} className="text-mk-fg3 shrink-0" />;
  }
}

export interface FileTreeProps {
  nodes: TreeNode[];
  activeFile: string | null;
  rootFile: string | null;
  /** Open tabs (marked in the tree). */
  openFiles?: string[];
  /** Room peers: a colored dot shows who has which file open. */
  peers?: PeerInfo[];
  onSelectFile: (path: string) => void;
  onSetRootFile?: (path: string) => void;
  onCreateNode: (relPath: string, isDir: boolean) => Promise<void>;
  onRenameNode: (oldRelPath: string, newRelPath: string) => Promise<void>;
  onDeleteNode: (relPath: string) => Promise<void>;
  /** Bumped by the panel header buttons to start creating a file / folder at the root. */
  createRequest?: { isDir: boolean; seq: number } | null;
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
  openFiles = [],
  peers = [],
  onSelectFile,
  onSetRootFile,
  onCreateNode,
  onRenameNode,
  onDeleteNode,
  createRequest = null,
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

  useEffect(() => {
    if (createRequest) handleStartCreate(createRequest.isDir);
  }, [createRequest]);

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

  const handleStartRename = (node: TreeNode) => {
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

  const renderTree = (items: TreeNode[], depth = 0): ReactNode => {
    return items.map((node) => {
      const isDir = node.is_dir;
      const isCollapsed = collapsedDirs.has(node.path);
      const isActive = !isDir && activeFile === node.path;
      const isRoot = !isDir && rootFile === node.path;
      const isOpen = !isDir && openFiles.includes(node.path);
      const here = isDir ? [] : peers.filter((p) => !p.isSelf && p.file === node.path);
      const isRenamingThis = renaming?.oldRelPath === node.path;

      if (isRenamingThis) {
        return (
          <div
            key={node.path}
            className="flex items-center gap-1.5 h-7 pr-1 bg-mk-bg3 border-l-2 border-mk-yellow text-xs"
            style={{ paddingLeft: `${depth * 14 + 10}px` }}
          >
            {isDir ? <Folder size={14} className="text-mk-fg2 shrink-0" /> : getFileIcon(node.name)}
            <input
              ref={renameInputRef}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
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
            className={`group relative flex items-center gap-1.5 h-7 pr-2 text-xs select-none cursor-pointer ${
              isActive ? "bg-mk-bg text-mk-fg font-medium" : "text-mk-fg2 hover:bg-mk-hover hover:text-mk-fg"
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
            <span
              className={`truncate flex-1 font-mono text-[11px] ${node.remote ? "italic text-mk-fg3" : ""} ${isOpen && !isActive ? "text-mk-fg" : ""}`}
              title={node.remote ? t("files.remote") : node.path}
            >
              {node.name}
            </span>

            {/* Peers with this file open */}
            {here.length > 0 && (
              <span className="flex -space-x-0.5 shrink-0" title={here.map((p) => p.name).join(", ")}>
                {here.slice(0, 3).map((p) => (
                  <span key={p.clientID} className="w-2 h-2 rounded-full ring-1 ring-mk-bg2" style={{ backgroundColor: p.color }} />
                ))}
              </span>
            )}

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
            {/* Overlaid on the row's right end (same background), so hovering never changes the row height. */}
            <div
              className={`absolute right-1 inset-y-0 hidden group-hover:flex items-center gap-0.5 pl-3 ${
                isActive ? "bg-mk-bg" : "bg-mk-hover"
              }`}
            >
              {!isDir && node.name.toLowerCase().endsWith(".tex") && !isRoot && onSetRootFile && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSetRootFile(node.path);
                  }}
                  className="p-1 text-mk-fg3 hover:text-mk-yellow hover:bg-mk-bg3 cursor-pointer rounded"
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
                  className="p-1 text-mk-fg3 hover:text-mk-fg hover:bg-mk-bg3 cursor-pointer rounded"
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
                className="p-1 text-mk-fg3 hover:text-mk-fg hover:bg-mk-bg3 cursor-pointer rounded"
                title={t("files.rename")}
              >
                <Edit3 size={12} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setDeletingPath(node.path);
                }}
                className="p-1 text-mk-fg3 hover:text-mk-red hover:bg-mk-bg3 cursor-pointer rounded"
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
    <div aria-label={t("files.title")} className="h-full flex flex-col select-none text-xs">
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
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
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
                className="px-3 py-1 rounded bg-mk-red hover:bg-mk-red/80 text-mk-bg2 font-semibold cursor-pointer transition-colors"
              >
                {t("files.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

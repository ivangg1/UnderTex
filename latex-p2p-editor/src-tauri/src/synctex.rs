//! SyncTeX navigation between the compiled PDF and the project sources.
//!
//! Both engines are run with SyncTeX enabled (tectonic `--synctex`, pdflatex
//! `-synctex=1`), which leaves `<root>.synctex.gz` next to the PDF in the build
//! cache. This module parses that file and answers the two questions a viewer asks:
//!
//! * **edit** (inverse search): which source file and line produced the point
//!   `(page, x, y)` of the PDF;
//! * **view** (forward search): where on which page the material of
//!   `file:line` was typeset.
//!
//! The file lists its inputs by absolute path (tectonic) or relative to the
//! engine's working directory (pdflatex, e.g. `./chapters/one.tex`). Every path is
//! mapped back from the build cache to a project-relative one (`/` separated), so
//! nested root files (`thesis/main.tex`) and `\input{../shared/x}` both resolve to
//! the files the editor knows. Files outside the build cache (classes, packages)
//! are ignored.
//!
//! Coordinates over the API are PDF points (1/72 in) measured from the top-left
//! corner of the page, which is what pdf.js uses at scale 1.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use flate2::read::GzDecoder;
use serde::Serialize;

use crate::compiler::build_dir_for;
use crate::fsutil::resolve_inside;

/// TeX points per PDF (big) point.
const TEX_PT_PER_BP: f64 = 72.27 / 72.0;
/// Scaled points per TeX point.
const SP_PER_PT: f64 = 65536.0;
/// Slack (in sp, ≈ 2 pt) when deciding whether a click falls inside a line box.
const HIT_SLACK: i64 = 2 * 65536;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BoxKind {
    /// `(` … `)`: a line of text, the unit both searches work with.
    HBox,
    /// `[` … `]`: a paragraph, page body, minipage…
    VBox,
    /// `h`/`v`/`r`: void boxes and rules (included graphics, \rule).
    Void,
}

#[derive(Debug, Clone)]
struct SBox {
    kind: BoxKind,
    tag: u32,
    line: u32,
    /// Left edge and baseline (sp from the page's top-left corner).
    h: i64,
    v: i64,
    width: i64,
    height: i64,
    depth: i64,
}

impl SBox {
    fn top(&self) -> i64 {
        self.v - self.height
    }
    fn bottom(&self) -> i64 {
        self.v + self.depth
    }
    fn left(&self) -> i64 {
        self.h.min(self.h + self.width)
    }
    fn right(&self) -> i64 {
        self.h.max(self.h + self.width)
    }
    /// Lines, plus void boxes and rules that occupy space (graphics, `\rule`);
    /// paragraph indents and struts (zero height) are not something to hit.
    fn is_target(&self) -> bool {
        match self.kind {
            BoxKind::HBox => true,
            BoxKind::VBox => false,
            BoxKind::Void => self.width != 0 && self.height + self.depth > 0,
        }
    }
    fn area(&self) -> i128 {
        (self.right() - self.left()) as i128 * (self.bottom() - self.top()) as i128
    }
    fn contains(&self, x: i64, y: i64, slack: i64) -> bool {
        x >= self.left() - slack && x <= self.right() + slack && y >= self.top() - slack && y <= self.bottom() + slack
    }
    /// Distance from the point to the box (0 inside); vertical distance weighs
    /// more so a click between two lines prefers the line it is level with.
    fn distance(&self, x: i64, y: i64) -> f64 {
        let dx = if x < self.left() { self.left() - x } else if x > self.right() { x - self.right() } else { 0 };
        let dy = if y < self.top() { self.top() - y } else if y > self.bottom() { y - self.bottom() } else { 0 };
        (dx as f64).hypot(4.0 * dy as f64)
    }
}

/// A point record (`g` glue, `k` kern, `x` current point, `$` math) inside a box.
#[derive(Debug, Clone)]
struct Leaf {
    tag: u32,
    line: u32,
    h: i64,
    v: i64,
    /// Index of the innermost enclosing box on the same page.
    parent: Option<usize>,
}

#[derive(Debug, Default, Clone)]
struct Page {
    number: u32,
    boxes: Vec<SBox>,
    leaves: Vec<Leaf>,
}

/// A parsed `.synctex(.gz)` file.
#[derive(Debug, Default, Clone)]
pub struct Synctex {
    /// Input tag → path as written by the engine.
    inputs: HashMap<u32, String>,
    pages: Vec<Page>,
    unit: f64,
    magnification: f64,
    x_offset: f64,
    y_offset: f64,
}

/// Result of an inverse search.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct SourceLocation {
    /// Project-relative path (`/` separated).
    pub file: String,
    /// 1-based line.
    pub line: u32,
}

/// A rectangle on a PDF page, in PDF points from the page's top-left corner.
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
pub struct PdfRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Result of a forward search.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct PdfLocation {
    /// 1-based page number.
    pub page: u32,
    /// Union of `boxes`, handy for scrolling.
    #[serde(flatten)]
    pub rect: PdfRect,
    /// The typeset lines of the source line (for highlighting).
    pub boxes: Vec<PdfRect>,
    /// The source line that was actually found (the requested one, or the
    /// nearest line of the same file that produced output).
    pub line: u32,
}

/// `tag,line[,column]` → (tag, line).
fn parse_link(s: &str) -> Option<(u32, u32)> {
    let mut parts = s.split(',');
    let tag = parts.next()?.trim().parse().ok()?;
    let line = parts.next()?.trim().parse::<i64>().ok()?;
    Some((tag, line.max(0) as u32))
}

fn parse_ints(s: &str) -> Option<Vec<i64>> {
    s.split(',').map(|n| n.trim().parse::<i64>().ok()).collect()
}

/// Splits `tag,line:h,v[:W,H,D]` into its link, point and optional size.
fn parse_record(body: &str) -> Option<((u32, u32), (i64, i64), Option<(i64, i64, i64)>)> {
    let mut fields = body.split(':');
    let link = parse_link(fields.next()?)?;
    let point = parse_ints(fields.next()?)?;
    let (h, v) = (*point.first()?, *point.get(1)?);
    let size = match fields.next() {
        Some(s) => {
            let n = parse_ints(s)?;
            Some((*n.first()?, n.get(1).copied().unwrap_or(0), n.get(2).copied().unwrap_or(0)))
        }
        None => None,
    };
    Some((link, (h, v), size))
}

impl Synctex {
    /// Parses the uncompressed text of a SyncTeX file. Unknown or malformed
    /// records are skipped rather than failing the whole file.
    pub fn parse(text: &str) -> Synctex {
        let mut st = Synctex { unit: 1.0, magnification: 1000.0, ..Default::default() };
        let mut page: Option<Page> = None;
        let mut stack: Vec<usize> = Vec::new();
        let mut in_content = false;

        for raw in text.lines() {
            let line = raw.trim_end_matches('\r');
            if let Some(rest) = line.strip_prefix("Input:") {
                if let Some((tag, path)) = rest.split_once(':') {
                    if let Ok(tag) = tag.trim().parse() {
                        if !path.is_empty() {
                            st.inputs.insert(tag, path.to_string());
                        }
                    }
                }
                continue;
            }
            if !in_content {
                if line == "Content:" {
                    in_content = true;
                } else if let Some(v) = line.strip_prefix("Unit:") {
                    st.unit = v.trim().parse().unwrap_or(1.0);
                } else if let Some(v) = line.strip_prefix("Magnification:") {
                    st.magnification = v.trim().parse().unwrap_or(1000.0);
                } else if let Some(v) = line.strip_prefix("X Offset:") {
                    st.x_offset = v.trim().parse().unwrap_or(0.0);
                } else if let Some(v) = line.strip_prefix("Y Offset:") {
                    st.y_offset = v.trim().parse().unwrap_or(0.0);
                }
                continue;
            }
            if line == "Postamble:" {
                break;
            }
            let Some(kind) = line.chars().next() else { continue };
            let body = &line[kind.len_utf8()..];
            match kind {
                '{' => {
                    if let Some(done) = page.take() {
                        st.pages.push(done);
                    }
                    stack.clear();
                    page = Some(Page { number: body.trim().parse().unwrap_or(st.pages.len() as u32 + 1), ..Default::default() });
                }
                '}' => {
                    if let Some(done) = page.take() {
                        st.pages.push(done);
                    }
                    stack.clear();
                }
                '(' | '[' | 'h' | 'v' | 'r' => {
                    let Some(p) = page.as_mut() else { continue };
                    let Some(((tag, line_no), (h, v), size)) = parse_record(body) else { continue };
                    let (width, height, depth) = size.unwrap_or((0, 0, 0));
                    let kind = match kind {
                        '(' => BoxKind::HBox,
                        '[' => BoxKind::VBox,
                        _ => BoxKind::Void,
                    };
                    p.boxes.push(SBox { kind, tag, line: line_no, h, v, width, height, depth });
                    if matches!(kind, BoxKind::HBox | BoxKind::VBox) {
                        stack.push(p.boxes.len() - 1);
                    }
                }
                ')' | ']' => {
                    stack.pop();
                }
                'g' | 'k' | 'x' | '$' => {
                    let Some(p) = page.as_mut() else { continue };
                    let Some(((tag, line_no), (h, v), _)) = parse_record(body) else { continue };
                    p.leaves.push(Leaf { tag, line: line_no, h, v, parent: stack.last().copied() });
                }
                _ => {} // `!` byte offsets, forms (`<`, `>`, `f`), anything newer
            }
        }
        if let Some(done) = page.take() {
            st.pages.push(done);
        }
        st
    }

    /// Reads and parses a `.synctex.gz` (or plain `.synctex`) file.
    pub fn load(path: &Path) -> Result<Synctex, String> {
        let bytes = fs::read(path).map_err(|e| format!("No SyncTeX data ({}): {e}", path.display()))?;
        let text = if bytes.starts_with(&[0x1f, 0x8b]) {
            let mut out = String::new();
            GzDecoder::new(bytes.as_slice())
                .read_to_string(&mut out)
                .map_err(|e| format!("Corrupt SyncTeX file: {e}"))?;
            out
        } else {
            String::from_utf8_lossy(&bytes).into_owned()
        };
        Ok(Synctex::parse(&text))
    }

    /// sp (synctex units) → PDF points.
    fn to_bp(&self, value: i64, offset: f64) -> f64 {
        (value as f64 * self.unit * self.magnification / 1000.0 + offset) / SP_PER_PT / TEX_PT_PER_BP
    }

    /// PDF points → sp (synctex units).
    fn from_bp(&self, value: f64, offset: f64) -> i64 {
        ((value * TEX_PT_PER_BP * SP_PER_PT - offset) * 1000.0 / self.magnification / self.unit).round() as i64
    }

    fn rect(&self, b: &SBox) -> PdfRect {
        let x = self.to_bp(b.left(), self.x_offset);
        let y = self.to_bp(b.top(), self.y_offset);
        PdfRect {
            x,
            y,
            width: self.to_bp(b.right(), self.x_offset) - x,
            height: self.to_bp(b.bottom(), self.y_offset) - y,
        }
    }

    fn page(&self, number: u32) -> Option<&Page> {
        self.pages.iter().find(|p| p.number == number)
    }

    /// Inverse search: the source line typeset at `(x, y)` (PDF points) on `page`.
    /// `resolve` maps an input tag to a project file; tags it rejects are skipped.
    fn edit_with(&self, page: u32, x: f64, y: f64, resolve: &dyn Fn(u32) -> Option<String>) -> Option<SourceLocation> {
        let page = self.page(page)?;
        let (px, py) = (self.from_bp(x, self.x_offset), self.from_bp(y, self.y_offset));
        let in_project = |tag: u32| resolve(tag);

        // Candidate lines: the smallest hbox under the pointer, else the nearest ones.
        let hboxes: Vec<usize> = (0..page.boxes.len()).filter(|&i| page.boxes[i].is_target()).collect();
        let mut order: Vec<usize> = hboxes.iter().copied().filter(|&i| page.boxes[i].contains(px, py, HIT_SLACK)).collect();
        order.sort_by_key(|&i| page.boxes[i].area());
        let mut rest: Vec<usize> = hboxes.iter().copied().filter(|i| !order.contains(i)).collect();
        rest.sort_by(|&a, &b| page.boxes[a].distance(px, py).total_cmp(&page.boxes[b].distance(px, py)));
        order.extend(rest);

        for bi in order {
            // Within the line, the record closest to the pointer wins: a paragraph
            // set from several input lines yields the line under the click.
            let mut leaves: Vec<&Leaf> = page.leaves.iter().filter(|l| l.parent == Some(bi)).collect();
            leaves.sort_by_key(|l| (l.h - px).abs() + 4 * (l.v - py).abs());
            for leaf in leaves {
                if let Some(file) = in_project(leaf.tag) {
                    return Some(SourceLocation { file, line: leaf.line });
                }
            }
            let b = &page.boxes[bi];
            if let Some(file) = in_project(b.tag) {
                return Some(SourceLocation { file, line: b.line });
            }
        }
        None
    }

    /// Forward search: where `line` of the input(s) in `tags` was typeset. Falls
    /// back to the nearest following (else preceding) line that produced output.
    fn view_with(&self, tags: &[u32], line: u32) -> Option<PdfLocation> {
        let ours = |tag: u32| tags.contains(&tag);
        let mut lines = BTreeSet::new();
        for p in &self.pages {
            lines.extend(p.leaves.iter().filter(|l| ours(l.tag) && l.line > 0).map(|l| l.line));
            lines.extend(p.boxes.iter().filter(|b| b.is_target() && ours(b.tag) && b.line > 0).map(|b| b.line));
        }
        let best = lines.range(line..).next().or_else(|| lines.range(..line).next_back()).copied()?;

        for p in &self.pages {
            let mut picked: BTreeSet<usize> = BTreeSet::new();
            for leaf in p.leaves.iter().filter(|l| ours(l.tag) && l.line == best) {
                if let Some(parent) = leaf.parent {
                    picked.insert(parent);
                }
            }
            for (i, b) in p.boxes.iter().enumerate() {
                if b.is_target() && ours(b.tag) && b.line == best {
                    picked.insert(i);
                }
            }
            // A leaf directly inside a vbox would highlight the whole paragraph or
            // page body; prefer the lines when there are any.
            let lines_only: Vec<usize> = picked.iter().copied().filter(|&i| p.boxes[i].kind != BoxKind::VBox).collect();
            let chosen = if lines_only.is_empty() { picked.into_iter().collect() } else { lines_only };
            let boxes: Vec<PdfRect> = chosen
                .iter()
                .map(|&i| self.rect(&p.boxes[i]))
                .filter(|r| r.width > 0.0 || r.height > 0.0)
                .collect();
            if boxes.is_empty() {
                continue;
            }
            let x0 = boxes.iter().map(|r| r.x).fold(f64::INFINITY, f64::min);
            let y0 = boxes.iter().map(|r| r.y).fold(f64::INFINITY, f64::min);
            let x1 = boxes.iter().map(|r| r.x + r.width).fold(f64::NEG_INFINITY, f64::max);
            let y1 = boxes.iter().map(|r| r.y + r.height).fold(f64::NEG_INFINITY, f64::max);
            return Some(PdfLocation {
                page: p.number,
                rect: PdfRect { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
                boxes,
                line: best,
            });
        }
        None
    }
}

// ─── Mapping build-cache paths to project paths ──────────────────────

/// Resolves `.` and `..` without touching the file system.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Maps SyncTeX input paths of one build to project-relative paths.
pub struct PathMapper {
    /// The build directory, as given and canonicalized (macOS `/var` → `/private/var`).
    roots: Vec<PathBuf>,
    /// Working directory of the engine (folder of the root file in the build).
    cwd: PathBuf,
}

impl PathMapper {
    pub fn new(build_dir: &Path, main_dir: &Path) -> PathMapper {
        let mut roots = vec![normalize(build_dir)];
        if let Ok(canon) = build_dir.canonicalize() {
            if !roots.contains(&canon) {
                roots.push(canon);
            }
        }
        PathMapper { roots, cwd: normalize(main_dir) }
    }

    /// Project-relative path of `input`, or `None` for files outside the build
    /// (TeX distribution files).
    pub fn to_project(&self, input: &str) -> Option<String> {
        let raw = Path::new(input);
        let joined = normalize(&if raw.is_absolute() { raw.to_path_buf() } else { self.cwd.join(raw) });
        let mut candidates = vec![joined.clone()];
        if let Ok(canon) = joined.canonicalize() {
            candidates.push(canon);
        }
        for path in &candidates {
            for root in &self.roots {
                if let Ok(rel) = path.strip_prefix(root) {
                    let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
                    if !parts.is_empty() {
                        return Some(parts.join("/"));
                    }
                }
            }
        }
        None
    }
}

impl Synctex {
    /// Inverse search mapped to project paths.
    pub fn edit(&self, mapper: &PathMapper, page: u32, x: f64, y: f64) -> Option<SourceLocation> {
        let resolve = |tag: u32| self.inputs.get(&tag).and_then(|p| mapper.to_project(p));
        self.edit_with(page, x, y, &resolve)
    }

    /// Forward search for a project file (path relative to the project).
    pub fn view(&self, mapper: &PathMapper, file: &str, line: u32) -> Option<PdfLocation> {
        let wanted = file.trim_start_matches("./").replace('\\', "/");
        let tags: Vec<u32> = self
            .inputs
            .iter()
            .filter(|(_, p)| mapper.to_project(p).as_deref() == Some(wanted.as_str()))
            .map(|(&t, _)| t)
            .collect();
        if tags.is_empty() {
            return None;
        }
        self.view_with(&tags, line)
    }
}

// ─── Entry points used by the Tauri commands ─────────────────────────

/// Parsed files are cached by path + modification time + size, so repeated
/// clicks do not re-inflate a multi-megabyte file.
type CacheEntry = (PathBuf, SystemTime, u64, Arc<Synctex>);

fn cache() -> &'static Mutex<Option<CacheEntry>> {
    static CACHE: OnceLock<Mutex<Option<CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn load_cached(path: &Path) -> Result<Arc<Synctex>, String> {
    let meta = fs::metadata(path).map_err(|_| "No SyncTeX data yet: compile the document first.".to_string())?;
    let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let mut guard = cache().lock().unwrap_or_else(|e| e.into_inner());
    if let Some((p, m, len, data)) = guard.as_ref() {
        if p == path && *m == mtime && *len == meta.len() {
            return Ok(data.clone());
        }
    }
    let data = Arc::new(Synctex::load(path)?);
    *guard = Some((path.to_path_buf(), mtime, meta.len(), data.clone()));
    Ok(data)
}

/// The SyncTeX file of a project's last build and the mapper for its paths.
fn locate(project_path: &str, main_file: &str) -> Result<(PathBuf, PathMapper), String> {
    let build_dir = build_dir_for(project_path);
    let build_main = resolve_inside(&build_dir, main_file)?;
    let main_dir = build_main.parent().map(Path::to_path_buf).unwrap_or_else(|| build_dir.clone());
    let synctex = build_main.with_extension("synctex.gz");
    Ok((synctex, PathMapper::new(&build_dir, &main_dir)))
}

/// PDF position → source. `Ok(None)` when nothing of the project is there.
pub fn edit(project_path: &str, main_file: &str, page: u32, x: f64, y: f64) -> Result<Option<SourceLocation>, String> {
    let (path, mapper) = locate(project_path, main_file)?;
    Ok(load_cached(&path)?.edit(&mapper, page, x, y))
}

/// Source → PDF position. `Ok(None)` when the file produced no output.
pub fn view(project_path: &str, main_file: &str, file: &str, line: u32) -> Result<Option<PdfLocation>, String> {
    let (path, mapper) = locate(project_path, main_file)?;
    Ok(load_cached(&path)?.view(&mapper, file, line))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compiler::{compile, find_engine, BuildOptions};
    use std::time::Duration;

    const TECTONIC_FIXTURE: &str = include_str!("../tests/fixtures/tectonic.synctex");
    const PDFLATEX_FIXTURE: &str = include_str!("../tests/fixtures/pdflatex.synctex");

    fn mapper(build: &str, cwd: &str) -> PathMapper {
        PathMapper::new(Path::new(build), Path::new(cwd))
    }

    #[test]
    fn mapper_turns_build_paths_into_project_paths() {
        let m = mapper("/cache/build-1", "/cache/build-1/thesis");
        assert_eq!(m.to_project("/cache/build-1/thesis/main.tex").as_deref(), Some("thesis/main.tex"));
        assert_eq!(m.to_project("./chapters/one.tex").as_deref(), Some("thesis/chapters/one.tex"));
        assert_eq!(m.to_project("chapters/../intro.tex").as_deref(), Some("thesis/intro.tex"));
        assert_eq!(m.to_project("../shared/macros.tex").as_deref(), Some("shared/macros.tex"));
        assert_eq!(m.to_project("/usr/local/texlive/2025/texmf-dist/tex/latex/base/article.cls"), None);
        assert_eq!(m.to_project("../../outside.tex"), None);
    }

    #[test]
    fn parser_reads_header_inputs_pages_and_records() {
        let st = Synctex::parse(TECTONIC_FIXTURE);
        assert_eq!(st.pages.len(), 2);
        assert_eq!(st.pages[0].number, 1);
        assert_eq!(st.inputs.get(&1).map(String::as_str), Some("/build/proj/main.tex"));
        assert_eq!(st.inputs.get(&7).map(String::as_str), Some("/build/proj/chapters/one.tex"));
        assert!(!st.inputs.contains_key(&2), "empty Input lines (tectonic internals) are dropped");
        assert!(st.pages[0].boxes.iter().any(|b| b.kind == BoxKind::HBox && b.tag == 7 && b.line == 3));
        assert!(st.pages[0].leaves.iter().all(|l| l.parent.is_some()));
    }

    #[test]
    fn forward_and_inverse_search_round_trip_on_the_tectonic_fixture() {
        let st = Synctex::parse(TECTONIC_FIXTURE);
        let m = mapper("/build/proj", "/build/proj");
        let hit = st.view(&m, "chapters/one.tex", 2).expect("chapter line 2 is typeset");
        assert_eq!(hit.page, 1);
        assert_eq!(hit.line, 2);
        assert_eq!(hit.boxes.len(), 1);
        // The line box of "Chapter one text second line here." (8799519sp ≈ 133.8bp from the left).
        assert!((hit.rect.x - 8799519.0 / 65536.0 * 72.0 / 72.27).abs() < 0.01);
        assert!(hit.rect.width > 300.0 && hit.rect.height > 5.0);

        // Clicking the right half of that line lands on the record from line 2.
        let loc = st.edit(&m, 1, hit.rect.x + hit.rect.width * 0.4, hit.rect.y + hit.rect.height / 2.0).unwrap();
        assert_eq!(loc, SourceLocation { file: "chapters/one.tex".into(), line: 2 });
        // Its left edge belongs to line 1 of the same file.
        let loc = st.edit(&m, 1, hit.rect.x + 2.0, hit.rect.y + hit.rect.height / 2.0).unwrap();
        assert_eq!(loc, SourceLocation { file: "chapters/one.tex".into(), line: 1 });

        // Root file text on page 2.
        let end = st.view(&m, "main.tex", 7).unwrap();
        assert_eq!(end.page, 2);
        let back = st.edit(&m, 2, end.rect.x + 5.0, end.rect.y + end.rect.height / 2.0).unwrap();
        assert_eq!(back, SourceLocation { file: "main.tex".into(), line: 7 });
    }

    #[test]
    fn forward_search_falls_back_to_the_nearest_typeset_line() {
        let st = Synctex::parse(TECTONIC_FIXTURE);
        let m = mapper("/build/proj", "/build/proj");
        // Past the end of the file: the last typeset line.
        assert_eq!(st.view(&m, "chapters/one.tex", 99).unwrap().line, 5);
        assert_eq!(st.view(&m, "missing.tex", 1), None);
    }

    #[test]
    fn pdflatex_style_relative_inputs_and_columns_are_understood() {
        let st = Synctex::parse(PDFLATEX_FIXTURE);
        let m = mapper("/build/proj", "/build/proj/thesis");
        let hit = st.view(&m, "thesis/chapters/intro.tex", 2).expect("relative input mapped");
        assert_eq!(hit.page, 1);
        let loc = st.edit(&m, 1, hit.rect.x + 10.0, hit.rect.y + hit.rect.height / 2.0).unwrap();
        assert_eq!(loc, SourceLocation { file: "thesis/chapters/intro.tex".into(), line: 2 });
        // A blank stretch of the file falls forward to the next typeset line.
        assert_eq!(st.view(&m, "thesis/chapters/intro.tex", 3).unwrap().line, 5);
        let shared = st.view(&m, "shared/abstract.tex", 1).expect("../ input mapped");
        assert_eq!(shared.page, 1);
        // A rule / included graphic is a target of its own.
        let rule = st.view(&m, "shared/abstract.tex", 2).unwrap();
        assert!((rule.rect.width - 100.0 * 72.0 / 72.27).abs() < 0.01);
        let back = st.edit(&m, 1, rule.rect.x + 50.0, rule.rect.y + 50.0).unwrap();
        assert_eq!(back, SourceLocation { file: "shared/abstract.tex".into(), line: 2 });
        // The running head comes from the class file (tag 2): never reported, the
        // nearest project line is used instead.
        let top = st.edit(&m, 1, 300.0, 40.0).unwrap();
        assert!(top.file.starts_with("thesis/") || top.file.starts_with("shared/"), "{top:?}");
        assert_eq!(st.edit(&m, 9, 10.0, 10.0), None, "unknown page");
    }

    #[test]
    fn units_magnification_and_offsets_are_applied() {
        let text = "SyncTeX Version:1\nInput:1:/b/main.tex\nOutput:pdf\nMagnification:2000\nUnit:2\nX Offset:0\nY Offset:0\nContent:\n{1\n(1,1:100,200:300,50,10\nx1,1:100,200\n)\n}1\nPostamble:\n";
        let st = Synctex::parse(text);
        let hit = st.view(&mapper("/b", "/b"), "main.tex", 1).unwrap();
        let k = 2.0 * 2.0 / 65536.0 / TEX_PT_PER_BP;
        assert!((hit.rect.x - 100.0 * k).abs() < 1e-9);
        assert!((hit.rect.y - 150.0 * k).abs() < 1e-9);
        assert!((hit.rect.width - 300.0 * k).abs() < 1e-9);
        assert!((hit.rect.height - 60.0 * k).abs() < 1e-9);
    }

    fn engine_available() -> bool {
        find_engine().is_some()
    }

    fn temp_project(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("synctex_{name}_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn real_build_writes_synctex_and_both_directions_work_for_a_nested_root() {
        if !engine_available() {
            eprintln!("skipping: no TeX engine installed");
            return;
        }
        let dir = temp_project("nested");
        fs::create_dir_all(dir.join("thesis/chapters")).unwrap();
        fs::create_dir_all(dir.join("shared")).unwrap();
        let root = "\\documentclass{article}\n\\begin{document}\nOpening words of the root file.\n\n\\input{chapters/one}\n\n\\input{../shared/note}\n\nClosing words.\n\\end{document}\n";
        fs::write(dir.join("thesis/main.tex"), root).unwrap();
        fs::write(dir.join("thesis/chapters/one.tex"), "\\section{First}\nA sentence that lives in the first chapter.\n\nAnother paragraph of the chapter.\n").unwrap();
        fs::write(dir.join("shared/note.tex"), "A shared note included with a parent path.\n").unwrap();
        let project = dir.to_str().unwrap();

        let out = compile(project, "thesis/main.tex", root, &BuildOptions::default(), Duration::from_secs(120)).unwrap();
        assert!(out.success, "{}", out.logs);
        let synctex_file = build_dir_for(project).join("thesis/main.synctex.gz");
        assert!(synctex_file.is_file(), "the build writes SyncTeX next to the PDF");
        assert!(!dir.join("thesis/main.synctex.gz").exists(), "the project folder stays clean");

        for (file, line) in [("thesis/chapters/one.tex", 2), ("thesis/main.tex", 9), ("shared/note.tex", 1), ("thesis/chapters/one.tex", 4)] {
            let hit = view(project, "thesis/main.tex", file, line).unwrap().unwrap_or_else(|| panic!("{file}:{line} not found"));
            assert_eq!(hit.page, 1);
            assert_eq!(hit.line, line);
            assert!(hit.rect.y > 0.0 && hit.rect.y < 792.0 && hit.rect.width > 0.0);
            let back = edit(project, "thesis/main.tex", hit.page, hit.rect.x + 3.0, hit.rect.y + hit.rect.height / 2.0)
                .unwrap()
                .expect("inverse search hits the same line");
            assert_eq!(back, SourceLocation { file: file.to_string(), line }, "round trip of {file}:{line}");
        }

        // An incremental rebuild (cache reused) refreshes the map: new lines shift the text down.
        let before = view(project, "thesis/main.tex", "thesis/main.tex", 9).unwrap().unwrap();
        let root2 = root.replace("Opening words of the root file.\n", "Opening words of the root file.\n\nA new paragraph.\n\nAnd one more.\n");
        let out = compile(project, "thesis/main.tex", &root2, &BuildOptions::default(), Duration::from_secs(120)).unwrap();
        assert!(out.success, "{}", out.logs);
        let after = view(project, "thesis/main.tex", "thesis/main.tex", 13).unwrap().unwrap();
        assert!(after.rect.y > before.rect.y, "the cached map was not reused after the rebuild");

        let _ = fs::remove_dir_all(build_dir_for(project));
        let _ = fs::remove_dir_all(&dir);
    }
}

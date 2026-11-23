// mend: one patch tool for every AI edit format (SPEC.md v1).
// Node 22, standard library alone. Run as `node main.ts [options] [PATCH]`.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set;
// then this file hands over to runner.ts (last lines below).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: the single line to print. */
class Exit2 {
  line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

/** One edit of a patch. `move` names a rename the edit performs. */
interface Edit {
  apply: (tree: Tree) => void;
  move?: { from: string; to: string };
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC section 3: a path is safe when it is not empty, does not start with `/`, holds no `\`,
 *  and none of its `/`-separated segments is empty, `.` or `..`. */
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its own line break and whether it ends with one. */
interface LineDoc {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitDoc(text: string): LineDoc {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const parts = text.split(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinDoc(d: LineDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.finalBreak ? d.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private seen = new Map<string, string | null>();
  now = new Map<string, string | null>();

  /** The file's bytes before the patch (null: no such file). Directories count as no file. */
  original(p: string): string | null {
    if (!this.seen.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.seen.set(p, v);
    }
    return this.seen.get(p) as string | null;
  }

  /** The file's bytes as earlier edits left them. */
  current(p: string): string | null {
    return this.now.has(p) ? (this.now.get(p) as string | null) : this.original(p);
  }
}

// ---- Matching lines (SPEC section 5) ----

const trailTrim = (s: string): string => s.replace(/[ \t]+$/, '');
const edgeTrim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** Line equality at a tier: 0 exact, 1 trailing spaces/tabs ignored, 2 leading and trailing ignored. */
function lineSame(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailTrim(a) === trailTrim(b);
  return edgeTrim(a) === edgeTrim(b);
}

/** Every position at or after `from` where `needle` occurs in `hay` at this tier (occurrences may overlap). */
function findSpots(needle: string[], hay: string[], tier: number, from: number): number[] {
  const spots: number[] = [];
  if (needle.length === 0 || needle.length > hay.length) return spots;
  for (let i = Math.max(0, from); i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (!lineSame(needle[j]!, hay[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) spots.push(i);
  }
  return spots;
}

/** The first tier (0, then 1, then 2; strict allows 0 only) at which `needle` occurs at least once. */
function firstTierWith(needle: string[], hay: string[], strict: boolean, from: number): { tier: number; spots: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const spots = findSpots(needle, hay, t, from);
    if (spots.length > 0) return { tier: t, spots };
  }
  return null;
}

/** One line of N: a context line names its index in O, a new line has none. */
interface NewLine {
  text: string;
  ctxAt: number | null;
}

/** Render N at a match: context lines are the file's own matched lines; at tier 2 every other
 *  non-blank line starting with O's first line's indent has that indent replaced by the file's. */
function renderNew(nl: NewLine[], fileLines: string[], at: number, tier: number, oldLines: string[]): string[] {
  if (tier !== 2) return nl.map((e) => (e.ctxAt !== null ? fileLines[at + e.ctxAt]! : e.text));
  const f = leadOf(fileLines[at]!);
  const p = leadOf(oldLines[0]!);
  return nl.map((e) => {
    if (e.ctxAt !== null) return fileLines[at + e.ctxAt]!;
    const t = e.text;
    if (t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

/** O and N of a hunk or chunk body: context and `-` lines make O, context and `+` lines make N. */
interface EditBlock {
  oldLines: string[];
  newLines: NewLine[];
}

function blockFromBody(body: string[]): EditBlock {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  for (const line of body) {
    if (line.startsWith('\\')) continue;
    if (line === '' || line.startsWith(' ')) {
      const text = line === '' ? '' : line.slice(1);
      newLines.push({ text, ctxAt: oldLines.length });
      oldLines.push(text);
    } else if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      newLines.push({ text: line.slice(1), ctxAt: null });
    }
  }
  return { oldLines, newLines };
}

/** Whether a `\` line follows the body's last context or `+` line. */
function backslashAfterLastKept(body: string[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) last = i;
  }
  if (last < 0) return false;
  const next = body[last + 1];
  return next !== undefined && next.startsWith('\\');
}

// ---- JSON edits (SPEC section 9) ----

/** One JSON edit object, or null when it is not one (a parse fault). */
function jsonEditObject(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const path = o.path;
  const needFile = (tree: Tree): string => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    const t = tree.current(path);
    if (t === null) throw new Fail('missing', path);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return {
      apply(tree) {
        if (!safePath(path)) throw new Fail('unsafe', path);
        if (tree.current(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, text);
      },
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return {
      apply(tree) {
        const before = needFile(tree);
        const nl = before.indexOf('\n');
        const crlf = nl > 0 && before[nl - 1] === '\r';
        const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
        const text = norm(before);
        const old = norm(oldStr);
        let count = 0;
        for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
        if (count === 0) throw new Fail('no-match', path);
        if (count > 1) throw new Fail('ambiguous', path);
        const at = text.indexOf(old);
        const out = text.slice(0, at) + norm(newStr) + text.slice(at + old.length);
        tree.now.set(path, crlf ? out.replaceAll('\n', '\r\n') : out);
      },
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const atLine = o.insert_line;
    const add = patchLines(o.new_str);
    return {
      apply(tree) {
        const before = needFile(tree);
        const doc = splitDoc(before);
        if (atLine < 0 || atLine > doc.lines.length) throw new Fail('no-match', path);
        doc.lines.splice(atLine, 0, ...add);
        tree.now.set(path, joinDoc(doc));
      },
    };
  }
  return null;
}

/** A patch as one JSON array or as JSON Lines. */
function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEditObject(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Unified diffs (SPEC section 6) ----

interface UniHunk {
  a: number;
  body: string[];
}

interface UniSection {
  pairOld: string | null;
  pairNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UniHunk[];
}

/** A `--- `/`+++ ` path: text up to the first tab, surrounding spaces removed, one leading a/ or b/ removed. */
function cleanPairPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  const inHeader = (): boolean => cur !== null && cur.hunks.length === 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { pairOld: null, pairNew: null, diffOld: m[1]!, diffNew: m[2]!, renameOld: null, renameNew: null, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader()) {
        cur.pairOld = cleanPairPath(line.slice(4));
        cur.pairNew = cleanPairPath(lines[i + 1]!.slice(4));
      } else {
        cur = { pairOld: cleanPairPath(line.slice(4)), pairNew: cleanPairPath(lines[i + 1]!.slice(4)), diffOld: null, diffNew: null, renameOld: null, renameNew: null, newFile: false, deletedFile: false, hunks: [] };
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && inHeader()) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        // A `--- ` line followed by a `+++ ` line ends the body (it starts a new section),
        // even though it starts with `-`.
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      continue;
    }
    if (cur !== null && inHeader()) {
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      // A lone `+++ ` line in the header names the new path (§6: "`--- <path>`
      // and `+++ <path>` name the old and new path"). The parse-fault rule
      // covers only a `--- ` line without a following `+++ ` line; a lone
      // `+++ ` line is not an error.
      else if (line.startsWith('+++ ')) cur.pairNew = cleanPairPath(line.slice(4));
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply one hunk to a document. Returns the new document and the line-count drift it caused. */
function applyUniHunk(doc: LineDoc, h: UniHunk, drift: number, strict: boolean, path: string): { doc: LineDoc; delta: number } {
  const { oldLines, newLines } = blockFromBody(h.body);
  const lines = doc.lines;
  if (oldLines.length === 0) {
    const pos = Math.max(0, Math.min(h.a + drift, lines.length));
    const rendered = newLines.map((e) => e.text);
    const next = [...lines.slice(0, pos), ...rendered, ...lines.slice(pos)];
    const fin = pos === lines.length ? !backslashAfterLastKept(h.body) : doc.finalBreak;
    return { doc: { lines: next, br: doc.br, finalBreak: fin }, delta: newLines.length };
  }
  const found = firstTierWith(oldLines, lines, strict, 0);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + drift;
  let best = found.spots[0]!;
  for (const s of found.spots) {
    if (Math.abs(s - target) < Math.abs(best - target)) best = s;
  }
  const rendered = renderNew(newLines, lines, best, found.tier, oldLines);
  const next = [...lines.slice(0, best), ...rendered, ...lines.slice(best + oldLines.length)];
  const fin = best + oldLines.length === lines.length ? !backslashAfterLastKept(h.body) : doc.finalBreak;
  return { doc: { lines: next, br: doc.br, finalBreak: fin }, delta: newLines.length - oldLines.length };
}

function unifiedEdit(s: UniSection, strict: boolean): Edit {
  const oldPath = s.pairOld === '/dev/null' ? null : (s.pairOld ?? s.renameOld ?? s.diffOld);
  const newPath = s.pairNew === '/dev/null' ? null : (s.pairNew ?? s.renameNew ?? s.diffNew);
  const isCreate = s.pairOld === '/dev/null' || s.newFile;
  const isDelete = s.pairNew === '/dev/null' || s.deletedFile;
  if (isCreate) {
    const target = newPath;
    return {
      apply(tree) {
        if (target === null) throw new Fail('unsafe', '');
        if (!safePath(target)) throw new Fail('unsafe', target);
        if (tree.current(target) !== null) throw new Fail('exists', target);
        const made: string[] = [];
        let noBreak = false;
        for (const h of s.hunks) {
          for (let k = 0; k < h.body.length; k++) {
            const b = h.body[k]!;
            if (b.startsWith('+')) {
              made.push(b.slice(1));
              noBreak = k + 1 < h.body.length && h.body[k + 1]!.startsWith('\\');
            }
          }
        }
        tree.now.set(target, made.length === 0 ? '' : made.join('\n') + (noBreak ? '' : '\n'));
      },
    };
  }
  if (isDelete) {
    const target = oldPath;
    return {
      apply(tree) {
        if (target === null) throw new Fail('unsafe', '');
        if (!safePath(target)) throw new Fail('unsafe', target);
        if (tree.current(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
      },
    };
  }
  const isMove = oldPath !== null && newPath !== null && oldPath !== newPath;
  return {
    move: isMove ? { from: oldPath!, to: newPath! } : undefined,
    apply(tree) {
      if (oldPath !== null && !safePath(oldPath)) throw new Fail('unsafe', oldPath);
      if (newPath !== null && !safePath(newPath)) throw new Fail('unsafe', newPath);
      if (oldPath === null) throw new Fail('unsafe', '');
      const before = tree.current(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (isMove && tree.current(newPath!) !== null) throw new Fail('exists', newPath!);
      let doc = splitDoc(before);
      let drift = 0;
      for (const h of s.hunks) {
        const r = applyUniHunk(doc, h, drift, strict, oldPath);
        doc = r.doc;
        drift += r.delta;
      }
      const out = joinDoc(doc);
      if (isMove) {
        tree.now.set(newPath!, out);
        tree.now.set(oldPath, null);
      } else {
        tree.now.set(oldPath, out);
      }
    },
  };
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return {
    apply(tree) {
      if (!safePath(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.current(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.current(path);
      if (before === null) throw new Fail('missing', path);
      const doc = splitDoc(before);
      const found = firstTierWith(oldLines, doc.lines, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      if (found.spots.length > 1) throw new Fail('ambiguous', path);
      const at = found.spots[0]!;
      const nl: NewLine[] = newLines.map((t) => ({ text: t, ctxAt: null }));
      const rendered = renderNew(nl, doc.lines, at, found.tier, oldLines);
      const next = [...doc.lines.slice(0, at), ...rendered, ...doc.lines.slice(at + oldLines.length)];
      tree.now.set(path, joinDoc({ lines: next, br: doc.br, finalBreak: doc.finalBreak }));
    },
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    let mid = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        mid = k;
        break;
      }
    }
    if (mid < 0) throw new Exit2(`error: parse ${i + 1}`);
    let end = -1;
    for (let k = mid + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(srEdit(path, lines.slice(i + 1, mid), lines.slice(mid + 1, end), strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC section 8) ----

interface V4Chunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

interface V4Line {
  text: string;
  at: number;
}

function v4aAdd(path: string, content: V4Line[]): Edit {
  const made: string[] = [];
  for (const c of content) {
    if (c.text === '') made.push('');
    else if (c.text.startsWith('+')) made.push(c.text.slice(1));
    else throw new Exit2(`error: parse ${c.at + 1}`);
  }
  return {
    apply(tree) {
      if (!safePath(path)) throw new Fail('unsafe', path);
      if (tree.current(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, made.length === 0 ? '' : made.join('\n') + '\n');
    },
  };
}

function v4aDelete(path: string): Edit {
  return {
    apply(tree) {
      if (!safePath(path)) throw new Fail('unsafe', path);
      if (tree.current(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    },
  };
}

/** The first line at or after `from` equal to the anchor at the first tier with one, or -1. */
function findAnchor(anchor: string, lines: string[], strict: boolean, from: number): number {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    for (let i = Math.max(0, from); i < lines.length; i++) {
      if (lineSame(anchor, lines[i]!, t)) return i;
    }
  }
  return -1;
}

/** The first occurrence of O at or after the cursor at the first tier with one;
 *  an end-of-file chunk takes only an occurrence ending at the file's last line. */
function findV4Spot(oldLines: string[], lines: string[], strict: boolean, from: number, eof: boolean): { at: number; tier: number } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    for (const s of findSpots(oldLines, lines, t, from)) {
      if (!eof || s + oldLines.length === lines.length) return { at: s, tier: t };
    }
  }
  return null;
}

function v4aUpdate(path: string, content: V4Line[], headerAt: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (content.length > 0 && content[0]!.text.startsWith('*** Move to: ')) {
    moveTo = content[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4Chunk[] = [];
  let cur: V4Chunk | null = null;
  for (; idx < content.length; idx++) {
    const { text, at } = content[idx]!;
    if (text.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchor = text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
    } else if (text === '*** End of File') {
      if (cur === null) {
        // Bare `*** End of File` with no open chunk: SPEC names this line a
        // recognised chunk terminator, never a parse fault, so treat it as
        // an empty EOF-anchored chunk (a no-op insert of zero lines). The
        // section then has a chunk, so the "no chunk" rule does not fire.
        chunks.push({ anchor: null, body: [], eof: true });
      } else {
        cur.eof = true;
        chunks.push(cur);
        cur = null;
      }
    } else if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${at + 1}`);
        cur = { anchor: null, body: [], eof: false };
      }
      cur.body.push(text);
    } else {
      throw new Exit2(`error: parse ${at + 1}`);
    }
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerAt + 1}`);
  return {
    move: moveTo !== null ? { from: path, to: moveTo } : undefined,
    apply(tree) {
      if (!safePath(path)) throw new Fail('unsafe', path);
      if (moveTo !== null && !safePath(moveTo)) throw new Fail('unsafe', moveTo);
      const before = tree.current(path);
      if (before === null) throw new Fail('missing', path);
      if (moveTo !== null && tree.current(moveTo) !== null) throw new Fail('exists', moveTo);
      let doc = splitDoc(before);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          const found = findAnchor(ch.anchor, doc.lines, strict, cursor);
          if (found < 0) throw new Fail('no-match', path);
          cursor = found + 1;
        }
        const { oldLines, newLines } = blockFromBody(ch.body);
        if (oldLines.length === 0) {
          const pos = ch.eof ? doc.lines.length : cursor;
          const rendered = newLines.map((e) => e.text);
          doc = { lines: [...doc.lines.slice(0, pos), ...rendered, ...doc.lines.slice(pos)], br: doc.br, finalBreak: doc.finalBreak };
          cursor = pos + rendered.length;
          continue;
        }
        const spot = findV4Spot(oldLines, doc.lines, strict, cursor, ch.eof);
        if (spot === null) throw new Fail('no-match', path);
        const rendered = renderNew(newLines, doc.lines, spot.at, spot.tier, oldLines);
        doc = { lines: [...doc.lines.slice(0, spot.at), ...rendered, ...doc.lines.slice(spot.at + oldLines.length)], br: doc.br, finalBreak: doc.finalBreak };
        cursor = spot.at + rendered.length;
      }
      const out = joinDoc(doc);
      if (moveTo !== null) {
        tree.now.set(moveTo, out);
        tree.now.set(path, null);
      } else {
        tree.now.set(path, out);
      }
    },
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'del' : line.startsWith('*** Update File: ') ? 'upd' : null;
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headerAt = i;
    const path = line.slice(line.indexOf(': ') + 2).trim();
    const content: V4Line[] = [];
    i++;
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      content.push({ text: l, at: i });
      i++;
    }
    while (content.length > 0 && isBlank(content[content.length - 1]!.text)) content.pop();
    if (kind === 'add') edits.push(v4aAdd(path, content));
    else if (kind === 'del') {
      if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.at + 1}`);
      edits.push(v4aDelete(path));
    } else edits.push(v4aUpdate(path, content, headerAt, strict));
  }
  return edits;
}

// ---- Format detection (SPEC section 4) ----

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Invocation, output and exit codes (SPEC sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  const usage = { code: 2, out: ['error: usage'] };
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice(9);
        if (format !== null || !FORMATS.includes(v)) return usage;
        format = v;
      } else if (a === '--check') {
        if (check) return usage;
        check = true;
      } else if (a === '--strict') {
        if (strict) return usage;
        strict = true;
      } else {
        return usage;
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return usage;
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit.apply(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now = before;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const moved = new Set<string>();
  for (const edit of edits) {
    if (edit.move === undefined) continue;
    const { from, to } = edit.move;
    if (tree.original(from) !== null && tree.current(from) === null && tree.original(to) === null && tree.current(to) !== null) {
      rows.push({ key: to, line: `R ${from} -> ${to}` });
      moved.add(from);
      moved.add(to);
    }
  }
  for (const p of tree.now.keys()) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p) as string | null;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p) as string | null;
      if (was === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

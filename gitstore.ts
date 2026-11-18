// The git object engine: SHA-1 object ids, loose-object bytes, tree and
// commit codecs, packfile read/write (with delta resolution both ways),
// pkt-line framing, reachability walks, tree flatten/rebuild, a file-level
// three-way merge and a line diff. Everything the smart-HTTP handlers and
// the contents/pull-request machinery stand on, in-process: the trial pod
// has no git binary, so the forge speaks the wire itself.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The four object types git stores. */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** One stored object: its type and its exact content bytes (no header). */
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** A lookup from object id to object, the shape every walk below takes. */
export type ObjectLookup = (oid: string) => GitObject | undefined;

/** The all-zero object id: an unborn ref's value in the wire protocols. */
export const ZERO_OID = '0'.repeat(40);
/** git's LARGE_PACKET_MAX: the largest pkt-line, length header included. */
export const PKT_LINE_MAX = 65520;

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const HEX40 = /^[0-9a-f]{40}$/;

/** True for a lowercase 40-hex object id. */
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** An error in the git layer; handlers turn it into a refusal, never a crash. */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

// ---------------------------------------------------------------------------------------------
// object ids and loose objects
// ---------------------------------------------------------------------------------------------

/** git's object id: SHA-1 over `<type> <size>\0` followed by the content. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

/** One tree entry; `mode` is git's ASCII form (`100644`, `40000`, ...). */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object's bytes into its entries, in stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new GitError('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) throw new GitError('tree entry is truncated');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------------------------

/** A parsed commit: the headers the forge acts on, plus the raw message. */
export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  /** The author line's unix timestamp, or 0 when it does not parse. */
  readonly timestamp: number;
  readonly message: string;
}

/** The unix timestamp inside an `Name <email> 1700000000 +0000` identity line. */
function identityTimestamp(identity: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(identity);
  return match ? Number(match[1]) : 0;
}

/** Parse a commit object. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new GitError('commit has no valid tree header');
  return { tree, parents, author, committer, timestamp: identityTimestamp(author), message };
}

/** Build a commit object's bytes. `author`/`committer` are bare `Name <email>` identities. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const who = `${fields.author} ${fields.timestamp} +0000`;
  const by = `${fields.committer} ${fields.timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${by}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** A parsed annotated tag. */
export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const type = headers.get('type') ?? '';
  if (!isObjectId(headers.get('object') ?? '')) throw new GitError('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') throw new GitError('tag has a bad type header');
  return { object: headers.get('object')!, type: type as GitObjectType, tag: headers.get('tag') ?? '', tagger: headers.get('tagger') ?? '' };
}

/** Follow tag objects from `oid` to the first non-tag object; the oid itself when it is not a tag. */
export function peelTag(lookup: ObjectLookup, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = lookup(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** The commit a ref value names, peeling an annotated tag; null when it names no commit. */
export function peelToCommit(lookup: ObjectLookup, oid: string): string | null {
  const peeled = peelTag(lookup, oid);
  const object = lookup(peeled);
  return object && object.type === 'commit' ? peeled : null;
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/**
 * Every object reachable from `roots`: commit → tree + parents, tree → entries
 * (gitlinks skipped), tag → its target, blob → nothing. Missing objects stop
 * their branch of the walk instead of throwing: a walk over a peer's claimed
 * haves must tolerate ids this store does not hold.
 */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Every commit reachable from `tip` (itself included), following parents. */
export function commitAncestors(lookup: ObjectLookup, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return seen;
}

/**
 * True when `ancestor` is `tip` itself or one of its ancestors. The walk
 * stops the moment the ancestor is met: a fast-forward check usually names
 * the tip's own parent, and collecting the whole ancestry to answer it
 * would make every push pay for the chain's full length.
 */
export function isAncestor(lookup: ObjectLookup, ancestor: string, tip: string): boolean {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/**
 * A merge base of two commits: a common ancestor that is not itself an
 * ancestor of another common ancestor. The histories here are small and
 * mostly linear, so the simple paint-down suffices: take the ancestors of
 * `a` in breadth order from `b` and keep the first that is not redundant.
 */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  const ancestorsOfA = commitAncestors(lookup, a);
  if (ancestorsOfA.size === 0) return null;
  // Breadth-first from b: the first common ancestor met is a best one for the
  // near-linear histories a forge like this one sees.
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = lookup(oid);
    if (object && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// flattened trees: path -> blob
// ---------------------------------------------------------------------------------------------

/** One file in a flattened tree: its blob id and mode. */
export interface FlatFile {
  readonly oid: string;
  readonly mode: string;
}

/** Flatten a tree (recursively) into a path → blob map. */
export function flattenTree(lookup: ObjectLookup, treeOid: string): Map<string, FlatFile> {
  const out = new Map<string, FlatFile>();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/**
 * A small object writer over a lookup-backed store: `put` hashes and records
 * an object through the caller's sink and answers its id.
 */
export type PutObject = (type: GitObjectType, data: Buffer) => string;

/** Rebuild nested trees from a flattened path → blob map; returns the root tree id. */
export function buildTreeFromFlat(put: PutObject, flat: ReadonlyMap<string, FlatFile>): string {
  interface Node {
    files: Map<string, FlatFile>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, file] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i];
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1], file);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------------------------------------
// three-way merge at file granularity
// ---------------------------------------------------------------------------------------------

/** The outcome of a three-way tree merge: the merged tree, or the paths that conflict. */
export interface TreeMerge {
  readonly ok: boolean;
  readonly tree: string | null;
  readonly conflicts: string[];
}

/**
 * Merge `theirs` into `ours` relative to their common `base`, one file at a
 * time: a path only one side changed takes that side's version; a path both
 * sides changed to the same bytes takes it; a path both sides changed
 * differently (or one side deleted while the other edited) conflicts.
 */
export function mergeTrees(lookup: ObjectLookup, put: PutObject, baseTree: string, oursTree: string, theirsTree: string): TreeMerge {
  const base = flattenTree(lookup, baseTree);
  const ours = flattenTree(lookup, oursTree);
  const theirs = flattenTree(lookup, theirsTree);
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged = new Map<string, FlatFile>();
  const conflicts: string[] = [];
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const sameBlob = (x: FlatFile | undefined, y: FlatFile | undefined): boolean =>
      x === undefined && y === undefined ? true : x !== undefined && y !== undefined && x.oid === y.oid;
    if (sameBlob(o, t)) {
      if (o) merged.set(path, o);
    } else if (sameBlob(b, o)) {
      if (t) merged.set(path, t);
    } else if (sameBlob(b, t)) {
      if (o) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) return { ok: false, tree: null, conflicts: conflicts.sort() };
  return { ok: true, tree: buildTreeFromFlat(put, merged), conflicts: [] };
}

// ---------------------------------------------------------------------------------------------
// line diff (for pull request file lists)
// ---------------------------------------------------------------------------------------------

/** Added/deleted line counts between two texts, by a longest-common-subsequence walk. */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // Trailing newline artefacts: "a\n" splits to ["a", ""]; count real lines.
  if (oldLines.length && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length && newLines[newLines.length - 1] === '') newLines.pop();
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
  if (oldLines.length * newLines.length > 4_000_000) {
    // Too large for the DP table: every line counts as replaced. The counts
    // stay honest bounds (additions >= 1 whenever the new side is non-empty).
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const width = newLines.length + 1;
  const dp = new Uint32Array((oldLines.length + 1) * width);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] = oldLines[i] === newLines[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const common = dp[0];
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

// ---------------------------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------------------------

/** Encode one data pkt-line. */
export function pktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (data.length + 4 > PKT_LINE_MAX) throw new GitError(`pkt-line payload of ${data.length} bytes is too large`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

/** The flush packet (0000). */
export const PKT_FLUSH: Buffer = Buffer.from('0000', 'ascii');
/** The delimiter packet (0001) that separates protocol v2 sections. */
export const PKT_DELIM: Buffer = Buffer.from('0001', 'ascii');

/** One decoded pkt-line: a data payload, or one of the control packets. */
export type PktPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/**
 * Decode a complete buffer of pkt-lines. Answers the packets and how many
 * bytes they consumed; trailing bytes (a packfile after a command list) are
 * the caller's to keep. A malformed header throws GitError.
 */
export function decodePktLines(bytes: Uint8Array): { packets: PktPacket[]; consumed: number } {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX) throw new GitError(`invalid pkt-line length ${length}`);
    if (offset + length > buffer.length) break; // truncated: leave the rest unconsumed
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

/** Encode one object's pack entry header (the type/size varint). */
function packEntryHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas): header, deflated entries, SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const object of list) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Read a pack entry's size varint; answers the size and the offset just past it. */
function readPackVarint(buffer: Buffer, start: number): { size: number; first: number; next: number } {
  if (start >= buffer.length) throw new GitError('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new GitError('pack entry size varint is truncated');
    byte = buffer[offset];
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new GitError('pack entry size varint is too long');
  }
  return { size, first, next: offset };
}

/** Read an OFS_DELTA base offset; answers the offset distance and the next offset. */
function readOfsBase(buffer: Buffer, start: number): { distance: number; next: number } {
  if (start >= buffer.length) throw new GitError('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new GitError('ofs-delta base offset is truncated');
    byte = buffer[offset];
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { distance: value, next: offset };
}

/** Inflate the zlib stream starting at `offset`; answers its bytes and the offset past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (!result.engine.bytesWritten) throw new GitError(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new GitError('delta size varint is truncated');
      const byte = deltaBuffer[offset];
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new GitError('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) throw new GitError('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new GitError('delta copy offset is truncated');
          copyOffset += deltaBuffer[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new GitError('delta copy size is truncated');
          copySize += deltaBuffer[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new GitError('delta copy is out of the base');
      if (written + copySize > targetSize) throw new GitError('delta writes past its target size');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new GitError('delta insert is truncated');
      if (written + literal > targetSize) throw new GitError('delta writes past its target size');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new GitError('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new GitError('delta produced the wrong size');
  return out;
}

/**
 * Read a packfile and resolve every object in it, deltas included. A REF_DELTA
 * base the pack itself does not carry is asked of `external` (a thin pack's
 * base, which the receiving store already holds). Answers a map of object id
 * to object. Throws GitError on any structural problem.
 */
export function readPack(pack: Uint8Array, external?: ObjectLookup): Map<string, GitObject> {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new GitError('pack is too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new GitError('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new GitError(`unsupported pack version ${version}`);
  const declared = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new GitError('pack checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset: number;
    baseOid: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < declared; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0), baseOffset: -1, baseOid: '' };
    if (typeCode === 6) {
      const base = readOfsBase(buffer, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.distance;
      if (entry.baseOffset < 12) throw new GitError('ofs-delta base offset is invalid');
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new GitError('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new GitError(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new GitError('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new GitError('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): GitObject => {
    if (resolving.has(entry.offset)) throw new GitError('delta cycle in pack');
    resolving.add(entry.offset);
    let resolved: GitObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (!baseEntry) throw new GitError('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const inPack = resolvedByOid.get(entry.baseOid);
      const base = inPack ?? external?.(entry.baseOid);
      if (!base) throw new GitError(`ref-delta base ${entry.baseOid} is not available`);
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      resolved = { type: CODE_TYPE[entry.typeCode], data: entry.data };
    }
    resolving.delete(entry.offset);
    resolvedByOid.set(hashObject(resolved.type, resolved.data), resolved);
    return resolved;
  };
  for (const entry of raw) {
    const object = resolve(entry);
    const oid = hashObject(object.type, object.data);
    if (!objects.has(oid)) objects.set(oid, object);
  }
  return objects;
}

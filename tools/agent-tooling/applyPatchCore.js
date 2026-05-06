"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatApplyPatchSummary = formatApplyPatchSummary;
exports.applyPatchFromText = applyPatchFromText;
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const BEGIN_PATCH = '*** Begin Patch';
const END_PATCH = '*** End Patch';
const ADD_FILE = '*** Add File: ';
const DELETE_FILE = '*** Delete File: ';
const UPDATE_FILE = '*** Update File: ';
const MOVE_TO = '*** Move to: ';
const EOF_MARKER = '*** End of File';
function toLines(input) {
    return input.replace(/\r\n/g, '\n').split('\n');
}
function normalizePatchInput(raw) {
    const trimmed = raw.trim();
    if (!trimmed) {
        throw new Error('apply_patch: empty input');
    }
    if (trimmed.startsWith('```')) {
        const lines = toLines(trimmed);
        if (lines.length >= 3 && lines[0].startsWith('```') && lines[lines.length - 1] === '```') {
            return lines.slice(1, -1).join('\n').trim();
        }
    }
    return trimmed;
}
function parsePatchText(input) {
    const lines = toLines(normalizePatchInput(input));
    if (lines.length < 2 || lines[0] !== BEGIN_PATCH || lines[lines.length - 1] !== END_PATCH) {
        throw new Error(`apply_patch: expected '${BEGIN_PATCH}' ... '${END_PATCH}' boundaries`);
    }
    const hunks = [];
    let i = 1;
    const last = lines.length - 1;
    while (i < last) {
        const line = lines[i];
        if (!line.trim()) {
            i += 1;
            continue;
        }
        if (line.startsWith(ADD_FILE)) {
            const filePath = line.slice(ADD_FILE.length).trim();
            i += 1;
            const contentLines = [];
            while (i < last && !lines[i].startsWith('*** ')) {
                const addLine = lines[i];
                if (!addLine.startsWith('+')) {
                    throw new Error(`apply_patch: invalid add-file line '${addLine}' for ${filePath}`);
                }
                contentLines.push(addLine.slice(1));
                i += 1;
            }
            hunks.push({ kind: 'add', filePath, contents: contentLines.join('\n') });
            continue;
        }
        if (line.startsWith(DELETE_FILE)) {
            const filePath = line.slice(DELETE_FILE.length).trim();
            hunks.push({ kind: 'delete', filePath });
            i += 1;
            continue;
        }
        if (line.startsWith(UPDATE_FILE)) {
            const filePath = line.slice(UPDATE_FILE.length).trim();
            i += 1;
            let moveTo;
            if (i < last && lines[i].startsWith(MOVE_TO)) {
                moveTo = lines[i].slice(MOVE_TO.length).trim();
                i += 1;
            }
            const chunks = [];
            while (i < last && !lines[i].startsWith('*** ')) {
                if (!lines[i].trim()) {
                    i += 1;
                    continue;
                }
                if (lines[i] === '@@' || lines[i].startsWith('@@ ')) {
                    i += 1;
                }
                const oldLines = [];
                const newLines = [];
                let isEndOfFile = false;
                let consumed = 0;
                while (i < last) {
                    const body = lines[i];
                    if (body === EOF_MARKER) {
                        isEndOfFile = true;
                        i += 1;
                        break;
                    }
                    if (body.startsWith('*** ') || body === '@@' || body.startsWith('@@ ')) {
                        break;
                    }
                    const marker = body[0];
                    if (marker === ' ') {
                        const value = body.slice(1);
                        oldLines.push(value);
                        newLines.push(value);
                        consumed += 1;
                        i += 1;
                        continue;
                    }
                    if (marker === '+') {
                        newLines.push(body.slice(1));
                        consumed += 1;
                        i += 1;
                        continue;
                    }
                    if (marker === '-') {
                        oldLines.push(body.slice(1));
                        consumed += 1;
                        i += 1;
                        continue;
                    }
                    throw new Error(`apply_patch: invalid update line '${body}' in ${filePath}`);
                }
                if (consumed === 0) {
                    throw new Error(`apply_patch: empty update chunk in ${filePath}`);
                }
                chunks.push({ oldLines, newLines, isEndOfFile });
            }
            if (chunks.length === 0) {
                throw new Error(`apply_patch: update hunk for ${filePath} has no chunks`);
            }
            hunks.push({ kind: 'update', filePath, moveTo, chunks });
            continue;
        }
        throw new Error(`apply_patch: unknown hunk header '${line}'`);
    }
    return hunks;
}
function isInsideRoot(root, target) {
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function resolveWithinRoot(root, filePath) {
    const candidate = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
    if (!isInsideRoot(root, candidate)) {
        throw new Error(`apply_patch: path escapes workspace root: ${filePath}`);
    }
    const rel = path.relative(root, candidate);
    return { absolute: candidate, display: rel || path.basename(candidate) };
}
function splitPathSegments(value) {
    return value.split(/[\\/]+/).filter(Boolean);
}
function matchesRootBase(segment, rootBase) {
    if (process.platform === 'win32') {
        return segment.toLowerCase() === rootBase.toLowerCase();
    }
    return segment === rootBase;
}
async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    }
    catch {
        return false;
    }
}
async function directoryExists(targetPath) {
    try {
        const stats = await fs.stat(targetPath);
        return stats.isDirectory();
    }
    catch {
        return false;
    }
}
async function resolveWithinRootWithRecovery(root, filePath, mode) {
    const resolved = resolveWithinRoot(root, filePath);
    if (path.isAbsolute(filePath)) {
        return resolved;
    }
    const normalizedPath = filePath.trim();
    if (!normalizedPath) {
        return resolved;
    }
    const segments = splitPathSegments(normalizedPath);
    if (segments.length < 2) {
        return resolved;
    }
    const rootBase = path.basename(path.resolve(root));
    if (!matchesRootBase(segments[0], rootBase)) {
        return resolved;
    }
    const trimmedRelative = segments.slice(1).join('/');
    if (!trimmedRelative) {
        return resolved;
    }
    const recovered = resolveWithinRoot(root, trimmedRelative);
    if (recovered.absolute === resolved.absolute) {
        return resolved;
    }
    if (mode === 'source') {
        if (await pathExists(resolved.absolute)) {
            return resolved;
        }
        if (await pathExists(recovered.absolute)) {
            return recovered;
        }
        return resolved;
    }
    const resolvedParent = path.dirname(resolved.absolute);
    if (await directoryExists(resolvedParent)) {
        return resolved;
    }
    const recoveredParent = path.dirname(recovered.absolute);
    if (await directoryExists(recoveredParent)) {
        return recovered;
    }
    return resolved;
}
function findSliceIndex(haystack, needle, from, requireEof) {
    if (needle.length === 0) {
        return requireEof ? haystack.length : from;
    }
    if (requireEof) {
        const start = haystack.length - needle.length;
        if (start < 0) {
            return -1;
        }
        for (let i = 0; i < needle.length; i += 1) {
            if (haystack[start + i] !== needle[i]) {
                return -1;
            }
        }
        return start;
    }
    for (let i = Math.max(0, from); i <= haystack.length - needle.length; i += 1) {
        let ok = true;
        for (let j = 0; j < needle.length; j += 1) {
            if (haystack[i + j] !== needle[j]) {
                ok = false;
                break;
            }
        }
        if (ok) {
            return i;
        }
    }
    return -1;
}
function applyUpdateChunks(original, chunks) {
    const hadTrailingNewline = original.endsWith('\n');
    let lines = toLines(hadTrailingNewline ? original.slice(0, -1) : original);
    if (lines.length === 1 && lines[0] === '') {
        lines = [];
    }
    let cursor = 0;
    for (const chunk of chunks) {
        let index = findSliceIndex(lines, chunk.oldLines, cursor, chunk.isEndOfFile);
        if (index < 0 && cursor > 0) {
            index = findSliceIndex(lines, chunk.oldLines, 0, chunk.isEndOfFile);
        }
        if (index < 0) {
            throw new Error('apply_patch: could not match update chunk context in target file');
        }
        lines.splice(index, chunk.oldLines.length, ...chunk.newLines);
        cursor = index + chunk.newLines.length;
    }
    const result = lines.join('\n');
    return hadTrailingNewline ? `${result}\n` : result;
}
async function applyHunks(root, hunks) {
    const summary = { added: [], modified: [], deleted: [] };
    const seen = {
        added: new Set(),
        modified: new Set(),
        deleted: new Set()
    };
    const record = (bucket, value) => {
        if (seen[bucket].has(value)) {
            return;
        }
        seen[bucket].add(value);
        summary[bucket].push(value);
    };
    const snapshots = new Map();
    const rememberSnapshot = async (absolutePath) => {
        if (snapshots.has(absolutePath)) {
            return;
        }
        if (await pathExists(absolutePath)) {
            const content = await fs.readFile(absolutePath, 'utf8');
            snapshots.set(absolutePath, { existed: true, content });
            return;
        }
        snapshots.set(absolutePath, { existed: false, content: '' });
    };
    const rollback = async () => {
        for (const [absolutePath, snapshot] of snapshots.entries()) {
            if (snapshot.existed) {
                await fs.mkdir(path.dirname(absolutePath), { recursive: true });
                await fs.writeFile(absolutePath, snapshot.content, 'utf8');
                continue;
            }
            if (await pathExists(absolutePath)) {
                await fs.rm(absolutePath, { force: false });
            }
        }
    };
    try {
        for (const hunk of hunks) {
            if (hunk.kind === 'add') {
                const target = await resolveWithinRootWithRecovery(root, hunk.filePath, 'target');
                await rememberSnapshot(target.absolute);
                await fs.mkdir(path.dirname(target.absolute), { recursive: true });
                await fs.writeFile(target.absolute, hunk.contents, 'utf8');
                record('added', target.display);
                continue;
            }
            if (hunk.kind === 'delete') {
                const target = await resolveWithinRootWithRecovery(root, hunk.filePath, 'source');
                await rememberSnapshot(target.absolute);
                await fs.rm(target.absolute, { force: false });
                record('deleted', target.display);
                continue;
            }
            const source = await resolveWithinRootWithRecovery(root, hunk.filePath, 'source');
            await rememberSnapshot(source.absolute);
            const current = await fs.readFile(source.absolute, 'utf8');
            const updated = applyUpdateChunks(current, hunk.chunks);
            if (hunk.moveTo) {
                const moved = await resolveWithinRootWithRecovery(root, hunk.moveTo, 'target');
                await rememberSnapshot(moved.absolute);
                await fs.mkdir(path.dirname(moved.absolute), { recursive: true });
                await fs.writeFile(moved.absolute, updated, 'utf8');
                await fs.rm(source.absolute, { force: false });
                record('modified', moved.display);
            }
            else {
                await fs.writeFile(source.absolute, updated, 'utf8');
                record('modified', source.display);
            }
        }
    }
    catch (error) {
        await rollback();
        throw error;
    }
    return summary;
}
function formatApplyPatchSummary(summary) {
    const lines = ['Success.', 'Updated the following files:'];
    for (const file of summary.added) {
        lines.push(`A ${file}`);
    }
    for (const file of summary.modified) {
        lines.push(`M ${file}`);
    }
    for (const file of summary.deleted) {
        lines.push(`D ${file}`);
    }
    return lines.join('\n');
}
async function applyPatchFromText(patchText, workspaceRoot) {
    const hunks = parsePatchText(patchText);
    if (hunks.length === 0) {
        throw new Error('apply_patch: no hunks found');
    }
    const summary = await applyHunks(workspaceRoot, hunks);
    return { summary, output: formatApplyPatchSummary(summary) };
}
//# sourceMappingURL=applyPatchCore.js.map

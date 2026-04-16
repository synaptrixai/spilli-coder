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
const crypto = __importStar(require("crypto"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const shared_1 = require("../shared");
const PROPOSAL_TTL_MS = 10 * 60 * 1000;
const pendingEditProposals = new Map();
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function pickIntegerWithAliases(input, names) {
    for (const name of names) {
        const value = input[name];
        if (typeof value === 'number' && Number.isInteger(value)) {
            return value;
        }
    }
    return undefined;
}
function pickStringWithAliases(input, names) {
    for (const name of names) {
        const value = input[name];
        if (typeof value === 'string') {
            return value;
        }
    }
    return undefined;
}
function rangeToOffset(text, range) {
    const lines = text.split('\n');
    const lineCount = Math.max(1, lines.length);
    const startLine = clamp(range.startLine, 1, lineCount);
    const endLine = clamp(range.endLine, 1, lineCount);
    const startLineText = lines[startLine - 1] ?? '';
    const endLineText = lines[endLine - 1] ?? '';
    const startCharacter = clamp(range.startCharacter, 0, startLineText.length);
    const endCharacter = clamp(range.endCharacter, 0, endLineText.length);
    let start = 0;
    for (let i = 0; i < startLine - 1; i += 1) {
        start += (lines[i] ?? '').length + 1;
    }
    start += startCharacter;
    let end = 0;
    for (let i = 0; i < endLine - 1; i += 1) {
        end += (lines[i] ?? '').length + 1;
    }
    end += endCharacter;
    return {
        start,
        end: Math.max(start, end)
    };
}
function toRangeWarnings(requested, resolved) {
    const warnings = [];
    if (requested.startLine !== resolved.startLine || requested.endLine !== resolved.endLine) {
        warnings.push('Requested line range was adjusted to fit the current file bounds.');
    }
    if (requested.startCharacter !== resolved.startCharacter ||
        requested.endCharacter !== resolved.endCharacter) {
        warnings.push('Requested character range was adjusted to fit the target lines.');
    }
    return warnings;
}
function buildUnifiedDiff(file, range, oldText, replacement) {
    const relativeFile = file.replace(/\\/g, '/');
    const oldLines = oldText.length > 0 ? oldText.split('\n') : [];
    const newLines = replacement.length > 0 ? replacement.split('\n') : [];
    const oldCount = oldLines.length;
    const newCount = newLines.length;
    const header = `@@ -${range.startLine},${oldCount} +${range.startLine},${newCount} @@`;
    const body = [
        ...oldLines.map(line => `-${line}`),
        ...newLines.map(line => `+${line}`)
    ];
    return [
        `--- a/${relativeFile}`,
        `+++ b/${relativeFile}`,
        header,
        ...body
    ].join('\n');
}
const workspaceTools = {
    id: 'workspace-tools',
    tools: [
        {
            contract: {
                name: 'workspace.searchText',
                description: 'Search text across workspace files.',
                args: '{"query": string, "maxResults"?: number}',
                returns: '{"query": string, "results": Array<{file, line, preview}>, "count": number}',
                notes: 'search result line values are 1-based.',
                includeByDefault: true,
                keywords: ['search', 'find text', 'grep', 'workspace', 'searchText', 'ide.searchText']
            },
            createTool: context => (0, shared_1.createTool)('workspace.searchText', async (input) => {
                if (typeof input.query !== 'string' || input.query.trim().length === 0) {
                    throw new Error('workspace.searchText requires a non-empty query string.');
                }
                const requestedMax = typeof input.maxResults === 'number' && Number.isInteger(input.maxResults) && input.maxResults > 0
                    ? input.maxResults
                    : context.maxSearchResults;
                const maxResults = Math.min(requestedMax, context.maxSearchResults);
                const results = [];
                const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,out}/**', 500);
                const query = input.query;
                for (const file of files) {
                    if (results.length >= maxResults) {
                        break;
                    }
                    try {
                        const bytes = await vscode.workspace.fs.readFile(file);
                        const text = Buffer.from(bytes).toString('utf8');
                        const lines = text.split(/\r?\n/);
                        for (let i = 0; i < lines.length; i += 1) {
                            if (!lines[i].includes(query)) {
                                continue;
                            }
                            results.push({
                                file: file.fsPath,
                                line: i + 1,
                                preview: lines[i].trim()
                            });
                            if (results.length >= maxResults) {
                                break;
                            }
                        }
                    }
                    catch {
                        // Ignore unreadable/binary files.
                    }
                }
                return JSON.stringify({ query: input.query, results, count: results.length });
            })
        },
        {
            contract: {
                name: 'workspace.readFile',
                description: 'Read file contents with optional line ranges.',
                args: '{"file": string} OR {"path": string} OR {"filePath": string}; optional range args: {"startLine": number, "endLine": number} OR {"line": number, "count": number} OR {"startLine": number, "count": number}',
                returns: '{"found": true, "file": string, "totalLines": number, "range"?: {"startLine": number, "endLine": number}, "truncated": boolean, "content": string, "numberedLines"?: Array<{"line": number, "text": string}>} OR {"found": false, ...}',
                notes: 'file/path accepts workspace-relative and absolute paths. line arguments are 1-based and inclusive.',
                includeByDefault: true,
                keywords: ['read file', 'open file', 'line range', 'numbered lines']
            },
            createTool: context => (0, shared_1.createTool)('workspace.readFile', async (input) => {
                const providedPath = (0, shared_1.pickFilePathArg)(input);
                if (!providedPath) {
                    throw new Error('workspace.readFile requires a file path.');
                }
                const requestedPath = providedPath.trim();
                let file;
                let text;
                const resolvedPath = (0, shared_1.resolvePath)(requestedPath, context.workspaceRoot);
                const pathInsideWorkspace = (0, shared_1.isInsideWorkspace)(resolvedPath, context.workspaceRoot);
                try {
                    file = pathInsideWorkspace ? (0, shared_1.normalizeInWorkspace)(requestedPath, context.workspaceRoot) : resolvedPath;
                    const uri = vscode.Uri.file(file);
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    text = Buffer.from(bytes).toString('utf8');
                }
                catch {
                    const suggestions = pathInsideWorkspace ? await context.findPathSuggestions(requestedPath) : [];
                    return JSON.stringify({
                        found: false,
                        requestedPath,
                        resolvedPath,
                        workspaceRoot: context.workspaceRoot,
                        guidance: suggestions.length > 0
                            ? 'The requested path was not found. Use one of the suggested workspace-relative paths in a follow-up workspace.readFile call.'
                            : pathInsideWorkspace
                                ? 'The requested path was not found in the workspace. Use workspace.searchText or try a different workspace-relative path.'
                                : 'The requested external path was not found or could not be read.',
                        suggestions
                    });
                }
                const requestedRange = (0, shared_1.parseRequestedLineRange)(input);
                const allLines = text.split(/\r?\n/);
                const totalLines = allLines.length;
                const includeLineNumbers = input.includeLineNumbers === true || requestedRange !== undefined;
                let content = text;
                let range;
                let numberedLines;
                if (requestedRange) {
                    const startIndex = Math.min(requestedRange.startLine - 1, allLines.length);
                    const endIndexExclusive = Math.min(requestedRange.endLine, allLines.length);
                    const selectedLines = allLines.slice(startIndex, endIndexExclusive);
                    content = selectedLines.join('\n');
                    const actualStartLine = Math.min(startIndex + 1, allLines.length);
                    const actualEndLine = Math.min(endIndexExclusive, allLines.length);
                    range = {
                        startLine: actualStartLine,
                        endLine: actualEndLine
                    };
                    if (includeLineNumbers) {
                        numberedLines = selectedLines.map((lineText, index) => ({
                            line: actualStartLine + index,
                            text: lineText
                        }));
                    }
                }
                else if (includeLineNumbers) {
                    numberedLines = allLines.map((lineText, index) => ({
                        line: index + 1,
                        text: lineText
                    }));
                }
                const requestedMax = typeof input.maxBytes === 'number' && Number.isInteger(input.maxBytes) && input.maxBytes > 0
                    ? input.maxBytes
                    : context.maxBytesPerRead;
                const maxBytes = Math.min(requestedMax, context.maxBytesPerRead);
                const contentBytes = Buffer.from(content, 'utf8');
                const truncated = contentBytes.length > maxBytes;
                const limited = truncated ? contentBytes.slice(0, maxBytes) : contentBytes;
                return JSON.stringify({
                    found: true,
                    file,
                    totalLines,
                    range,
                    truncated,
                    content: Buffer.from(limited).toString('utf8'),
                    numberedLines
                });
            })
        },
        {
            contract: {
                name: 'workspace.createFile',
                description: 'Create a new file in workspace, with optional overwrite.',
                args: '{"file": string, "content"?: string, "overwrite"?: boolean}',
                returns: '{"created": true, "file": string, "overwritten": boolean, "bytesWritten": number, "lineCount": number, "contentHash": string} OR {"created": false, "alreadyExists": true, ...}',
                includeByDefault: true,
                keywords: ['create file', 'new file', 'write file']
            },
            createTool: context => (0, shared_1.createTool)('workspace.createFile', async (input) => {
                const providedPath = (0, shared_1.pickFilePathArg)(input);
                if (!providedPath) {
                    throw new Error('workspace.createFile requires a file path.');
                }
                const requestedPath = providedPath.trim();
                const file = (0, shared_1.normalizeInWorkspace)(requestedPath, context.workspaceRoot);
                const uri = vscode.Uri.file(file);
                const overwrite = input.overwrite === true;
                const exists = await context.fileExists(uri);
                if (exists && !overwrite) {
                    const suggestedPath = await context.suggestAvailableIncrementedPath(file);
                    const suggestedRelativePath = path.relative(context.workspaceRoot, suggestedPath);
                    return JSON.stringify({
                        created: false,
                        alreadyExists: true,
                        file,
                        requestedPath,
                        message: 'File already exists. Ask the user whether to create a different file name using suggestedPath.',
                        suggestedPath: suggestedRelativePath,
                        suggestedFileName: path.basename(suggestedPath)
                    });
                }
                const dir = path.dirname(file);
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
                const content = typeof input.content === 'string' ? input.content : '';
                const contentBytes = Buffer.from(content, 'utf8');
                await vscode.workspace.fs.writeFile(uri, contentBytes);
                const contentHash = crypto.createHash('sha256').update(contentBytes).digest('hex');
                const lineCount = content.length === 0 ? 0 : content.split(/\r?\n/).length;
                return JSON.stringify({
                    file,
                    created: true,
                    overwritten: overwrite,
                    bytesWritten: contentBytes.length,
                    lineCount,
                    contentHash
                });
            })
        },
        {
            contract: {
                name: 'workspace.proposeEdit',
                description: 'Propose a targeted text edit over a line/character range in a file.',
                args: '{"file": string, "replacement"?: string, "startLine": number, "startCharacter": number, "endLine": number, "endCharacter": number, "summary"?: string, "expectedOldText"?: string}',
                returns: '{"proposalId": string | null, "file": string, "summary": string, "diff"?: string, "expiresAt"?: string, "approvalToken"?: string, "warnings"?: string[], "rangeAdjusted": boolean, "requestedRange": {...}, "resolvedRange": {...}, "readOnly"?: boolean, "currentText"?: string}',
                notes: 'Line values are 1-based and character values are 0-based. If replacement is omitted, this call returns a read-only range snapshot without creating an apply-able proposal.',
                includeByDefault: true,
                keywords: ['propose edit', 'apply proposed edit', 'range edit', 'workspace.proposeEdit']
            },
            createTool: context => (0, shared_1.createTool)('workspace.proposeEdit', async (input) => {
                const providedPath = (0, shared_1.pickFilePathArg)(input);
                if (!providedPath) {
                    throw new Error('workspace.proposeEdit requires a file path.');
                }
                const requestedStartLine = pickIntegerWithAliases(input, ['startLine', 'line_start', 'start']);
                const requestedEndLine = pickIntegerWithAliases(input, ['endLine', 'line_end', 'end']);
                const requestedStartCharacter = pickIntegerWithAliases(input, ['startCharacter', 'startChar', 'charStart']);
                const requestedEndCharacter = pickIntegerWithAliases(input, ['endCharacter', 'endChar', 'charEnd']);
                if (requestedStartLine === undefined ||
                    requestedEndLine === undefined ||
                    requestedStartCharacter === undefined ||
                    requestedEndCharacter === undefined) {
                    throw new Error('workspace.proposeEdit requires startLine, startCharacter, endLine, and endCharacter.');
                }
                if (requestedStartLine < 1 || requestedEndLine < requestedStartLine) {
                    throw new Error('workspace.proposeEdit requires 1-based line ranges where endLine >= startLine.');
                }
                if (requestedStartCharacter < 0 || requestedEndCharacter < 0) {
                    throw new Error('workspace.proposeEdit requires non-negative character values.');
                }
                const requestedPath = providedPath.trim();
                const file = (0, shared_1.normalizeInWorkspace)(requestedPath, context.workspaceRoot);
                const uri = vscode.Uri.file(file);
                const bytes = await vscode.workspace.fs.readFile(uri);
                const text = Buffer.from(bytes).toString('utf8');
                const lines = text.split('\n');
                const lineCount = Math.max(1, lines.length);
                const requestedRange = {
                    startLine: requestedStartLine,
                    startCharacter: requestedStartCharacter,
                    endLine: requestedEndLine,
                    endCharacter: requestedEndCharacter
                };
                const resolvedRange = {
                    startLine: clamp(requestedStartLine, 1, lineCount),
                    startCharacter: 0,
                    endLine: clamp(requestedEndLine, 1, lineCount),
                    endCharacter: 0
                };
                const startLineText = lines[resolvedRange.startLine - 1] ?? '';
                const endLineText = lines[resolvedRange.endLine - 1] ?? '';
                resolvedRange.startCharacter = clamp(requestedStartCharacter, 0, startLineText.length);
                resolvedRange.endCharacter = clamp(requestedEndCharacter, 0, endLineText.length);
                const offsets = rangeToOffset(text, resolvedRange);
                const currentText = text.slice(offsets.start, offsets.end);
                const replacement = pickStringWithAliases(input, ['replacement', 'newText', 'text', 'content']);
                const summary = pickStringWithAliases(input, ['summary']) ??
                    `Edit ${path.relative(context.workspaceRoot, file) || path.basename(file)}:${resolvedRange.startLine}-${resolvedRange.endLine}`;
                const warnings = toRangeWarnings(requestedRange, resolvedRange);
                const expectedOldText = pickStringWithAliases(input, ['expectedOldText']);
                if (typeof expectedOldText === 'string' && expectedOldText !== currentText) {
                    warnings.push('expectedOldText did not match current file content at the resolved range.');
                }
                if (replacement === undefined) {
                    return JSON.stringify({
                        proposalId: null,
                        file,
                        summary,
                        requestedRange,
                        resolvedRange,
                        rangeAdjusted: warnings.length > 0,
                        warnings,
                        readOnly: true,
                        currentText
                    });
                }
                const proposalId = `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
                const approvalToken = crypto.randomBytes(12).toString('hex');
                const expiresAt = Date.now() + PROPOSAL_TTL_MS;
                const diff = buildUnifiedDiff(path.relative(context.workspaceRoot, file) || path.basename(file), resolvedRange, currentText, replacement);
                const proposal = {
                    proposalId,
                    approvalToken,
                    expiresAt,
                    file,
                    summary,
                    replacement,
                    expectedOldText,
                    requestedRange,
                    resolvedRange,
                    warnings,
                    diff
                };
                pendingEditProposals.set(proposalId, proposal);
                return JSON.stringify({
                    proposalId,
                    file,
                    summary,
                    diff,
                    expiresAt: new Date(expiresAt).toISOString(),
                    approvalToken,
                    warnings,
                    rangeAdjusted: warnings.length > 0,
                    requestedRange,
                    resolvedRange
                });
            })
        },
        {
            contract: {
                name: 'workspace.applyProposedEdit',
                description: 'Apply a pending edit proposal created by workspace.proposeEdit.',
                args: '{"proposalId": string, "approvalToken": string}',
                returns: '{"applied": boolean, "proposalId": string, "file"?: string, "summary"?: string, "diff"?: string, "reason"?: string, "warnings"?: string[]}',
                notes: 'The approval token must match the token returned by workspace.proposeEdit.',
                includeByDefault: true,
                keywords: ['apply edit', 'approve edit', 'workspace.applyProposedEdit']
            },
            createTool: () => (0, shared_1.createTool)('workspace.applyProposedEdit', async (input) => {
                const proposalId = typeof input.proposalId === 'string' ? input.proposalId.trim() : '';
                const approvalToken = typeof input.approvalToken === 'string' ? input.approvalToken.trim() : '';
                if (!proposalId) {
                    throw new Error('workspace.applyProposedEdit requires proposalId.');
                }
                if (!approvalToken) {
                    throw new Error('workspace.applyProposedEdit requires approvalToken.');
                }
                const proposal = pendingEditProposals.get(proposalId);
                if (!proposal) {
                    return JSON.stringify({
                        applied: false,
                        proposalId,
                        reason: 'proposal_not_found'
                    });
                }
                if (Date.now() > proposal.expiresAt) {
                    pendingEditProposals.delete(proposalId);
                    return JSON.stringify({
                        applied: false,
                        proposalId,
                        reason: 'proposal_expired'
                    });
                }
                if (proposal.approvalToken !== approvalToken) {
                    return JSON.stringify({
                        applied: false,
                        proposalId,
                        reason: 'invalid_approval_token'
                    });
                }
                const uri = vscode.Uri.file(proposal.file);
                const bytes = await vscode.workspace.fs.readFile(uri);
                const text = Buffer.from(bytes).toString('utf8');
                const offsets = rangeToOffset(text, proposal.resolvedRange);
                const currentText = text.slice(offsets.start, offsets.end);
                if (typeof proposal.expectedOldText === 'string' && proposal.expectedOldText !== currentText) {
                    pendingEditProposals.delete(proposalId);
                    return JSON.stringify({
                        applied: false,
                        proposalId,
                        file: proposal.file,
                        summary: proposal.summary,
                        reason: 'stale_expected_old_text',
                        warnings: ['expectedOldText no longer matches the target file content.']
                    });
                }
                const updated = `${text.slice(0, offsets.start)}${proposal.replacement}${text.slice(offsets.end)}`;
                await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
                pendingEditProposals.delete(proposalId);
                return JSON.stringify({
                    applied: true,
                    proposalId,
                    file: proposal.file,
                    summary: proposal.summary,
                    diff: proposal.diff,
                    warnings: proposal.warnings
                });
            })
        }
    ]
};
exports.default = workspaceTools;
//# sourceMappingURL=workspaceTools.js.map
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
exports.createTool = createTool;
exports.parseShellCommandArg = parseShellCommandArg;
exports.normalizeInWorkspace = normalizeInWorkspace;
exports.resolvePath = resolvePath;
exports.isInsideWorkspace = isInsideWorkspace;
exports.coerceObject = coerceObject;
exports.pickFilePathArg = pickFilePathArg;
exports.pickIntegerArg = pickIntegerArg;
exports.parseRequestedLineRange = parseRequestedLineRange;
const path = __importStar(require("path"));
function normalizeForComparison(value) {
    const resolved = path.resolve(value);
    if (process.platform === 'win32') {
        return resolved.toLowerCase();
    }
    return resolved;
}
function isPathWithinRoot(candidatePath, workspaceRoot) {
    const root = normalizeForComparison(workspaceRoot);
    const candidate = normalizeForComparison(candidatePath);
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function createTool(name, func) {
    try {
        const { DynamicStructuredTool } = require('@langchain/core/tools');
        const zod = require('zod');
        return new DynamicStructuredTool({
            name,
            description: name,
            schema: zod.z.object({}).passthrough(),
            func
        });
    }
    catch {
        return {
            invoke: func
        };
    }
}
function parseShellCommandArg(value) {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
            return trimmed;
        }
    }
    if (Array.isArray(value)) {
        const parts = value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean);
        if (parts.length >= 3) {
            const shell = parts[0].toLowerCase();
            if ((shell === 'bash' || shell === 'sh' || shell === 'zsh') && (parts[1] === '-lc' || parts[1] === '-c')) {
                return parts.slice(2).join(' ').trim();
            }
            if ((shell === 'powershell' || shell === 'powershell.exe' || shell === 'pwsh' || shell === 'pwsh.exe')) {
                const commandFlagIndex = parts.findIndex(part => part.toLowerCase() === '-command' || part.toLowerCase() === '-c');
                if (commandFlagIndex >= 0 && commandFlagIndex + 1 < parts.length) {
                    return parts.slice(commandFlagIndex + 1).join(' ').trim();
                }
            }
        }
        const joined = parts.join(' ').trim();
        if (joined.length > 0) {
            return joined;
        }
    }
    throw new Error('container.exec requires a non-empty cmd (string or string[]).');
}
function pickShellCommandArg(input) {
    const directKeys = ['cmd', 'command', 'script', 'commandLine', 'commandText', 'shellCommand'];
    for (const key of directKeys) {
        if (!(key in input)) {
            continue;
        }
        const candidate = input[key];
        if (typeof candidate === 'string' || Array.isArray(candidate)) {
            return candidate;
        }
    }
    const nestedKeys = ['args', 'input', 'payload', 'params'];
    for (const nestedKey of nestedKeys) {
        const nested = coerceObject(input[nestedKey]);
        if (!nested) {
            continue;
        }
        for (const key of directKeys) {
            if (!(key in nested)) {
                continue;
            }
            const candidate = nested[key];
            if (typeof candidate === 'string' || Array.isArray(candidate)) {
                return candidate;
            }
        }
    }
    return undefined;
}
exports.pickShellCommandArg = pickShellCommandArg;
function normalizeInWorkspace(filePath, workspaceRoot) {
    const root = path.resolve(workspaceRoot);
    const absolute = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(root, filePath);
    if (!isPathWithinRoot(absolute, root)) {
        throw new Error('Path is outside workspace root.');
    }
    return absolute;
}
function resolvePath(filePath, workspaceRoot) {
    const root = path.resolve(workspaceRoot);
    return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
}
function isInsideWorkspace(filePath, workspaceRoot) {
    return isPathWithinRoot(filePath, workspaceRoot);
}
function coerceObject(value) {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    return value;
}
function pickFilePathArg(input) {
    const directCandidates = ['file', 'path', 'filePath', 'filepath', 'uri', 'targetPath'];
    for (const key of directCandidates) {
        const value = input[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }
    const nestedKeys = ['args', 'input', 'payload', 'params'];
    for (const nestedKey of nestedKeys) {
        const nested = coerceObject(input[nestedKey]);
        if (!nested) {
            continue;
        }
        for (const key of directCandidates) {
            const value = nested[key];
            if (typeof value === 'string' && value.trim().length > 0) {
                return value;
            }
        }
    }
    return undefined;
}
function pickIntegerArg(input, key) {
    const direct = input[key];
    if (typeof direct === 'number' && Number.isInteger(direct)) {
        return direct;
    }
    const nestedKeys = ['args', 'input', 'payload', 'params'];
    for (const nestedKey of nestedKeys) {
        const nested = coerceObject(input[nestedKey]);
        if (!nested) {
            continue;
        }
        const value = nested[key];
        if (typeof value === 'number' && Number.isInteger(value)) {
            return value;
        }
    }
    return undefined;
}
function parseRequestedLineRange(input) {
    const startLineCandidate = pickIntegerArg(input, 'startLine');
    const endLineCandidate = pickIntegerArg(input, 'endLine');
    const lineCandidate = pickIntegerArg(input, 'line');
    const countCandidate = pickIntegerArg(input, 'count');
    const hasStartEnd = startLineCandidate !== undefined || endLineCandidate !== undefined;
    const hasLineCount = lineCandidate !== undefined || countCandidate !== undefined;
    const hasStartLineCount = startLineCandidate !== undefined || countCandidate !== undefined;
    if (Number.isInteger(startLineCandidate) && Number.isInteger(endLineCandidate)) {
        const startLine = Number(startLineCandidate);
        const endLine = Number(endLineCandidate);
        if (startLine < 1 || endLine < startLine) {
            throw new Error('workspace.readFile requires 1-based line ranges where endLine >= startLine.');
        }
        return { startLine, endLine };
    }
    if (Number.isInteger(lineCandidate) && Number.isInteger(countCandidate)) {
        const startLine = Number(lineCandidate);
        const count = Number(countCandidate);
        if (startLine < 1 || count < 1) {
            throw new Error('workspace.readFile requires 1-based line and positive count values.');
        }
        return { startLine, endLine: startLine + count - 1 };
    }
    if (Number.isInteger(startLineCandidate) && Number.isInteger(countCandidate)) {
        const startLine = Number(startLineCandidate);
        const count = Number(countCandidate);
        if (startLine < 1 || count < 1) {
            throw new Error('workspace.readFile requires 1-based line and positive count values.');
        }
        return { startLine, endLine: startLine + count - 1 };
    }
    if (hasStartEnd) {
        throw new Error('workspace.readFile requires integer startLine and endLine values, or use startLine with count.');
    }
    if (hasLineCount || hasStartLineCount) {
        throw new Error('workspace.readFile requires integer line/startLine and count values.');
    }
    return undefined;
}
//# sourceMappingURL=shared.js.map

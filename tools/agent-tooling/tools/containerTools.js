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
exports.classifyContainerExecSoftFailure = classifyContainerExecSoftFailure;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("path"));
const util = __importStar(require("node:util"));
const applyPatchCore_1 = require("../applyPatchCore");
const shared_1 = require("../shared");
const execAsync = util.promisify(node_child_process_1.exec);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const MAX_OUTPUT_CHARS = 200_000;
function parseTimeoutMs(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_TIMEOUT_MS;
    }
    if (value <= 0) {
        return 0;
    }
    return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}
function parseMaxOutputChars(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
        return DEFAULT_MAX_OUTPUT_CHARS;
    }
    return Math.min(Math.floor(value), MAX_OUTPUT_CHARS);
}
function truncate(value, limit) {
    const text = typeof value === 'string' ? value : value ? String(value) : '';
    if (text.length <= limit) {
        return { text, truncated: false };
    }
    return { text: `${text.slice(0, limit)}...`, truncated: true };
}
function extractMissingPath(stderr) {
    const sedMatch = stderr.match(/can't read\s+([^:]+):\s+No such file or directory/i);
    if (sedMatch?.[1]) {
        return sedMatch[1].trim();
    }
    const lsMatch = stderr.match(/cannot access ['"]?([^'":]+)['"]?:\s+No such file or directory/i);
    if (lsMatch?.[1]) {
        return lsMatch[1].trim();
    }
    return undefined;
}
function derivePathSuggestion(cwd, missingPath) {
    const normalizedMissingPath = missingPath.trim().replace(/^['"]|['"]$/g, '');
    if (normalizedMissingPath.includes('/')) {
        const parts = normalizedMissingPath.split('/').filter(Boolean);
        for (let index = 1; index < parts.length; index += 1) {
            const trimmedCandidate = parts.slice(index).join('/');
            const candidateAbsolute = path.resolve(cwd, trimmedCandidate);
            if (fs.existsSync(candidateAbsolute)) {
                return trimmedCandidate;
            }
        }
    }
    const basename = path.basename(normalizedMissingPath);
    if (!basename || basename === '.' || basename === '..') {
        return undefined;
    }
    const queue = [cwd];
    let visitedDirectories = 0;
    const MAX_VISITED_DIRECTORIES = 2500;
    while (queue.length > 0 && visitedDirectories < MAX_VISITED_DIRECTORIES) {
        const current = queue.shift();
        if (!current) {
            continue;
        }
        visitedDirectories += 1;
        let entries = [];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.venv' || entry.name === 'venv') {
                    continue;
                }
                queue.push(fullPath);
                continue;
            }
            if (entry.isFile() && entry.name === basename) {
                return path.relative(cwd, fullPath).replace(/\\/g, '/');
            }
        }
    }
    return undefined;
}
function splitPathSegments(value) {
    return value.split(/[\\/]+/).filter(Boolean);
}
function resolveRecoveredCwd(requestedCwd, workspaceRoot) {
    const rawCwd = typeof requestedCwd === 'string' && requestedCwd.trim().length > 0
        ? requestedCwd.trim()
        : '.';
    if (path.isAbsolute(rawCwd)) {
        return (0, shared_1.normalizeInWorkspace)(rawCwd, workspaceRoot);
    }
    const direct = path.resolve(workspaceRoot, rawCwd);
    if (fs.existsSync(direct)) {
        return (0, shared_1.normalizeInWorkspace)(direct, workspaceRoot);
    }
    const rootBase = path.basename(path.resolve(workspaceRoot));
    const parts = splitPathSegments(rawCwd);
    while (parts.length > 0 && parts[0] === rootBase) {
        parts.shift();
        const candidateRelative = parts.length > 0 ? parts.join('/') : '.';
        const candidateAbsolute = path.resolve(workspaceRoot, candidateRelative);
        if (fs.existsSync(candidateAbsolute)) {
            return (0, shared_1.normalizeInWorkspace)(candidateAbsolute, workspaceRoot);
        }
    }
    return (0, shared_1.normalizeInWorkspace)(direct, workspaceRoot);
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function buildUnquotedPathRegex(pathText) {
    const escaped = escapeRegex(pathText);
    return new RegExp(`(^|[\\s=:])(${escaped})(?=([\\s]|$))`);
}
function buildQuotedPathRegex(pathText, quote) {
    const escaped = escapeRegex(pathText);
    return new RegExp(`(${quote})(${escaped})(${quote})`);
}
function buildRetriedCommandForMissingPath(command, missingPath, suggestedPath) {
    const source = missingPath.trim().replace(/^['"]|['"]$/g, '');
    const target = suggestedPath.trim().replace(/^['"]|['"]$/g, '');
    if (!source || !target || source === target) {
        return undefined;
    }
    const quotedSingle = buildQuotedPathRegex(source, "'");
    if (quotedSingle.test(command)) {
        return command.replace(quotedSingle, `$1${target}$3`);
    }
    const quotedDouble = buildQuotedPathRegex(source, '"');
    if (quotedDouble.test(command)) {
        return command.replace(quotedDouble, `$1${target}$3`);
    }
    const unquoted = buildUnquotedPathRegex(source);
    if (unquoted.test(command)) {
        return command.replace(unquoted, `$1${target}`);
    }
    return undefined;
}
function isLikelyPythonCommand(command) {
    const normalized = command.trim().toLowerCase();
    return /(^|\s)python([0-9.]*)?(\s|$)/.test(normalized) || normalized === 'pytest' || normalized.startsWith('pytest ');
}
function extractMissingPythonModule(stderr) {
    const moduleNotFound = stderr.match(/ModuleNotFoundError:\s+No module named ['"]?([A-Za-z0-9_.-]+)['"]?/i);
    if (moduleNotFound?.[1]) {
        return moduleNotFound[1];
    }
    const importError = stderr.match(/ImportError:\s+No module named ['"]?([A-Za-z0-9_.-]+)['"]?/i);
    if (importError?.[1]) {
        return importError[1];
    }
    return undefined;
}
function extractMissingCommand(stderr) {
    const shMatch = stderr.match(/(?:^|\n)(?:\/bin\/(?:sh|bash):\s*\d+:\s*)?([A-Za-z0-9_.-]+):\s+not found(?:\n|$)/i);
    if (shMatch?.[1]) {
        return shMatch[1].toLowerCase();
    }
    const commandNotFoundMatch = stderr.match(/(?:^|\n)([A-Za-z0-9_.-]+):\s+command not found(?:\n|$)/i);
    if (commandNotFoundMatch?.[1]) {
        return commandNotFoundMatch[1].toLowerCase();
    }
    const windowsMatch = stderr.match(/(?:^|\n)'([A-Za-z0-9_.-]+)'.*is not recognized as an internal or external command/i);
    if (windowsMatch?.[1]) {
        return windowsMatch[1].toLowerCase();
    }
    return undefined;
}
function isLikelyInvalidAgentChannelCommand(command) {
    const normalized = command.trim().toLowerCase();
    return normalized === 'analysis' || normalized === 'commentary' || normalized === 'final' || normalized === 'summary';
}
function isLikelySearchCommand(command) {
    const normalized = command.trim().toLowerCase();
    if (!normalized) {
        return false;
    }
    return /(^|[\s|;&])(grep|rg)(\s|$)/.test(normalized);
}
function classifyContainerExecSoftFailure(command, exitCode, stderr) {
    if (!isLikelyPythonCommand(command)) {
        if (exitCode === 1 &&
            stderr.trim().length === 0 &&
            isLikelySearchCommand(command)) {
            return {
                kind: 'search_no_match',
                searchCommand: command.trim(),
                guidance: 'Search command returned no matches (exit code 1). ' +
                    'Treat this as an empty result and continue by refining the query or path.'
            };
        }
        return undefined;
    }
    const missingPythonModule = extractMissingPythonModule(stderr);
    if (!missingPythonModule) {
        const missingCommand = extractMissingCommand(stderr);
        if (missingCommand === 'python' || missingCommand === 'python3' || missingCommand === 'pytest' || missingCommand === 'py') {
            return {
                kind: 'missing_python_runtime',
                missingCommand,
                guidance: `Python executable "${missingCommand}" is unavailable in this runtime. ` +
                    'Treat this as an environment limitation; prefer source inspection or try python3/py-compatible command variants when available.'
            };
        }
        return undefined;
    }
    return {
        kind: 'missing_python_module',
        missingPythonModule,
        guidance: `Python runtime dependency is unavailable (${missingPythonModule}). ` +
            'Treat this as an environment limitation and continue with source inspection without retrying the same import.'
    };
}
function buildExecPathEnv() {
    const bundledBinDir = path.resolve(__dirname, '..', 'bin');
    const currentPath = process.env.PATH ?? '';
    return {
        ...process.env,
        PATH: `${bundledBinDir}:${currentPath}`
    };
}
function resolveExecShell() {
    if (process.platform === 'win32') {
        return 'powershell.exe';
    }
    return undefined;
}
function extractApplyPatchPayload(command) {
    const trimmed = command.replace(/\r\n/g, '\n').trim();
    const match = trimmed.match(/^apply_patch(?:\s+[^\n]*)?\s+<<\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
    if (!match) {
        return undefined;
    }
    return match[2];
}
const containerTools = {
    id: 'container-tools',
    tools: [
        {
            contract: {
                name: 'container.exec',
                description: 'Execute a non-interactive shell command in the current workspace.',
                args: '{"cmd": string | string[], "cwd"?: string, "timeoutMs"?: number, "maxOutputChars"?: number}',
                returns: '{"ok": boolean, "command": string, "cwd": string, "exitCode": number, "stdout": string, "stderr": string, "stdoutTruncated": boolean, "stderrTruncated": boolean, "timedOut": boolean, "guidance"?: string, "softError"?: boolean, "softErrorKind"?: string, "missingPythonModule"?: string, "missingCommand"?: string, "missingPath"?: string, "suggestedPath"?: string}',
                notes: 'Command runs from workspace root by default. cwd must stay inside workspace root. apply_patch heredoc commands are intercepted and applied directly by extension runtime. Missing Python dependencies/runtimes, malformed command payloads, and no-match grep/rg searches are returned with softError=true for non-fatal diagnostics.',
                includeByDefault: true,
                keywords: ['container.exec', 'shell', 'bash', 'command', 'terminal', 'exec']
            },
            createTool: context => (0, shared_1.createTool)('container.exec', async (input) => {
                const cwd = resolveRecoveredCwd(input.cwd, context.workspaceRoot);
                const timeoutMs = parseTimeoutMs(input.timeoutMs);
                const maxOutputChars = parseMaxOutputChars(input.maxOutputChars);
                let command = '';
                try {
                    command = (0, shared_1.parseShellCommandArg)((0, shared_1.pickShellCommandArg)(input));
                }
                catch (error) {
                    const stderr = error instanceof Error ? error.message : String(error);
                    const stderrTrunc = truncate(stderr, maxOutputChars);
                    return JSON.stringify({
                        ok: false,
                        command: '',
                        cwd,
                        exitCode: -1,
                        signal: null,
                        stdout: '',
                        stderr: stderrTrunc.text,
                        guidance: 'Provide a non-empty "cmd" string or string[] (for example {"cmd":"ls -la"}).',
                        softError: true,
                        softErrorKind: 'invalid_command_payload',
                        stdoutTruncated: false,
                        stderrTruncated: stderrTrunc.truncated,
                        timedOut: false
                    });
                }
                if (isLikelyInvalidAgentChannelCommand(command)) {
                    return JSON.stringify({
                        ok: false,
                        command,
                        cwd,
                        exitCode: -1,
                        signal: null,
                        stdout: '',
                        stderr: `Rejected suspicious shell command: ${command}`,
                        guidance: 'This looks like an agent channel marker rather than a shell command. Provide an explicit executable command.',
                        softError: true,
                        softErrorKind: 'invalid_command_payload',
                        stdoutTruncated: false,
                        stderrTruncated: false,
                        timedOut: false
                    });
                }
                const applyPatchPayload = extractApplyPatchPayload(command);
                if (applyPatchPayload !== undefined) {
                    try {
                        const applied = await (0, applyPatchCore_1.applyPatchFromText)(applyPatchPayload, cwd);
                        const out = truncate(applied.output, maxOutputChars);
                        return JSON.stringify({
                            ok: true,
                            command,
                            cwd,
                            exitCode: 0,
                            stdout: out.text,
                            stderr: '',
                            stdoutTruncated: out.truncated,
                            stderrTruncated: false,
                            timedOut: false,
                            appliedBy: 'spilli-extension'
                        });
                    }
                    catch (err) {
                        const stderr = err instanceof Error ? err.message : String(err);
                        const stderrTrunc = truncate(stderr, maxOutputChars);
                        return JSON.stringify({
                            ok: false,
                            command,
                            cwd,
                            exitCode: 1,
                            signal: null,
                            stdout: '',
                            stderr: stderrTrunc.text,
                            stdoutTruncated: false,
                            stderrTruncated: stderrTrunc.truncated,
                            timedOut: false,
                            softError: true,
                            softErrorKind: 'apply_patch_failed',
                            guidance: 'apply_patch was intercepted by extension runtime and failed validation/application. Do not retry destructive patch variants; inspect file content and provide a targeted suggested edit or a corrected minimal patch.'
                        });
                    }
                }
                try {
                    const execOptions = {
                        cwd,
                        env: buildExecPathEnv(),
                        shell: resolveExecShell(),
                        timeout: timeoutMs > 0 ? timeoutMs : undefined,
                        maxBuffer: 10 * 1024 * 1024
                    };
                    const { stdout, stderr } = await execAsync(command, execOptions);
                    const out = truncate(stdout, maxOutputChars);
                    const err = truncate(stderr, maxOutputChars);
                    return JSON.stringify({
                        ok: true,
                        command,
                        cwd,
                        exitCode: 0,
                        stdout: out.text,
                        stderr: err.text,
                        stdoutTruncated: out.truncated,
                        stderrTruncated: err.truncated,
                        timedOut: false
                    });
                }
                catch (error) {
                    const err = error;
                    const out = truncate(err.stdout, maxOutputChars);
                    const stderrText = err.stderr ?? (error instanceof Error ? error.message : String(error));
                    const stderrTrunc = truncate(stderrText, maxOutputChars);
                    const missingPath = extractMissingPath(stderrTrunc.text);
                    const suggestedPath = missingPath ? derivePathSuggestion(cwd, missingPath) : undefined;
                    const retryCommand = missingPath && suggestedPath
                        ? buildRetriedCommandForMissingPath(command, missingPath, suggestedPath)
                        : undefined;
                    const exitCode = typeof err.code === 'number' ? err.code : -1;
                    const softFailure = classifyContainerExecSoftFailure(command, exitCode, stderrTrunc.text);
                    if (retryCommand && !softFailure) {
                        try {
                            const retry = await execAsync(retryCommand, {
                                cwd,
                                env: buildExecPathEnv(),
                                shell: resolveExecShell(),
                                timeout: timeoutMs > 0 ? timeoutMs : undefined,
                                maxBuffer: 10 * 1024 * 1024
                            });
                            const retryOut = truncate(retry.stdout, maxOutputChars);
                            const retryErr = truncate(retry.stderr, maxOutputChars);
                            return JSON.stringify({
                                ok: true,
                                command: retryCommand,
                                originalCommand: command,
                                cwd,
                                exitCode: 0,
                                stdout: retryOut.text,
                                stderr: retryErr.text,
                                guidance: `Recovered missing path by retrying with workspace-relative path: ${suggestedPath}`,
                                missingPath,
                                suggestedPath,
                                autoRecoveredPath: true,
                                stdoutTruncated: retryOut.truncated,
                                stderrTruncated: retryErr.truncated,
                                timedOut: false
                            });
                        }
                        catch {
                            // If retry fails, return original failure details below.
                        }
                    }
                    const guidance = softFailure?.guidance ?? (suggestedPath
                        ? `Path not found: ${missingPath}. Try workspace-relative path: ${suggestedPath}`
                        : undefined);
                    return JSON.stringify({
                        ok: false,
                        command,
                        cwd,
                        exitCode,
                        signal: err.signal ?? null,
                        stdout: out.text,
                        stderr: stderrTrunc.text,
                        guidance,
                        softError: Boolean(softFailure),
                        softErrorKind: softFailure?.kind,
                        missingPythonModule: softFailure?.kind === 'missing_python_module'
                            ? softFailure.missingPythonModule
                            : undefined,
                        missingCommand: softFailure?.kind === 'missing_python_runtime'
                            ? softFailure.missingCommand
                            : undefined,
                        searchCommand: softFailure?.kind === 'search_no_match'
                            ? softFailure.searchCommand
                            : undefined,
                        missingPath,
                        suggestedPath,
                        stdoutTruncated: out.truncated,
                        stderrTruncated: stderrTrunc.truncated,
                        timedOut: err.killed === true && timeoutMs > 0
                    });
                }
            })
        }
    ]
};
exports.default = containerTools;
//# sourceMappingURL=containerTools.js.map

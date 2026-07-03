'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { AgentLoop } = require('./agent/agentLoop');

const ALWAYS_AVAILABLE_CONTRACTS = [
  {
    name: 'tools.searchContracts',
    description: 'Search available tool contracts (including tools not yet active).',
    args: '{"query"?: string}',
    returns: '{"query": string, "count": number, "contracts": Array<{name, description, args, returns, notes?, enabled}>}',
    notes: 'Use this first when you need capabilities beyond the default context.',
    includeByDefault: true
  },
  {
    name: 'tools.enableTools',
    description: 'Enable additional tools in the current agent turn context.',
    args: '{"toolNames": string[]}',
    returns: '{"requested": string[], "enabled": string[], "resolved": Array<{requested, resolved}>, "unknown": string[], "activeToolCount": number}',
    notes: 'Enable only the specific tools you need right now. Prefers fully-qualified names but also accepts unambiguous short names.',
    includeByDefault: true
  }
];

const DEFAULT_CONTEXT_CONTRACTS = [
  {
    name: 'ide.getActiveEditorContext',
    description: 'Get active editor file, language, selection, and visible range.',
    args: '{}',
    returns: '{"active": boolean, "file"?: string, "languageId"?: string, "selection"?: {...}, "visibleRange"?: {...}}',
    notes: 'selection/visibleRange line values are 1-based. character values are 0-based.',
    includeByDefault: true
  },
  {
    name: 'ide.getSelectionText',
    description: 'Get selected text from the active editor.',
    args: '{}',
    returns: '{"text": string, "hasSelection": boolean}',
    includeByDefault: true
  },
  {
    name: 'ide.getDiagnostics',
    description: 'Get diagnostics for active file or requested file.',
    args: '{"file"?: string}',
    returns: '{"file": string, "diagnostics": Array<...>}',
    notes: 'diagnostic range line values are 1-based. character values are 0-based.',
    includeByDefault: true
  },
  {
    name: 'workspace.readFile',
    description: 'Read file contents with optional line ranges.',
    args:
      '{"file": string} OR {"path": string} OR {"filePath": string}; optional range args: {"startLine": number, "endLine": number} OR {"line": number, "count": number} OR {"startLine": number, "count": number}',
    returns:
      '{"found": true, "file": string, "totalLines": number, "range"?: {"startLine": number, "endLine": number}, "truncated": boolean, "content": string, "numberedLines"?: Array<{"line": number, "text": string}>} OR {"found": false, ...}',
    notes: 'file/path accepts workspace-relative and absolute paths. line arguments are 1-based and inclusive.',
    includeByDefault: true
  },
  {
    name: 'workspace.createFile',
    description: 'Create a new file in workspace, with optional overwrite.',
    args: '{"file": string, "content"?: string, "overwrite"?: boolean}',
    returns:
      '{"created": true, "file": string, "overwritten": boolean, "bytesWritten": number, "lineCount": number, "contentHash": string} OR {"created": false, "alreadyExists": true, ...}',
    includeByDefault: true
  },
  {
    name: 'workspace.proposeEdit',
    description: 'Propose a targeted text edit over a line/character range in a file.',
    args:
      '{"file": string, "replacement"?: string, "startLine": number, "startCharacter": number, "endLine": number, "endCharacter": number, "summary"?: string, "expectedOldText"?: string}',
    returns:
      '{"proposalId": string | null, "approvalToken": string, "file": string, "summary": string, "diff": string, "warnings": string[], "applied"?: boolean}',
    notes:
      'Line values are 1-based and character values are 0-based. The extension may require a separate workspace.applyProposedEdit approval flow unless auto-approval is enabled.',
    includeByDefault: true
  },
  {
    name: 'workspace.applyProposedEdit',
    description: 'Apply a pending edit proposal created by workspace.proposeEdit.',
    args: '{"proposalId": string, "approvalToken": string}',
    returns: '{"applied": boolean, "file"?: string, "reason"?: string}',
    includeByDefault: true
  },
  {
    name: 'container.exec',
    description: 'Execute a non-interactive shell command in the current workspace.',
    args: '{"cmd": string | string[], "cwd"?: string, "timeoutMs"?: number, "maxOutputChars"?: number}',
    returns:
      '{"ok": boolean, "command": string, "cwd": string, "exitCode": number, "stdout": string, "stderr": string, "stdoutTruncated": boolean, "stderrTruncated": boolean, "timedOut": boolean, "guidance"?: string, "softError"?: boolean, "softErrorKind"?: string}',
    notes:
      'Command runs from workspace root by default. cwd must stay inside workspace root. apply_patch heredoc commands are intercepted and applied directly by extension runtime.',
    includeByDefault: true
  }
];

const LEGACY_TOOL_NAME_ALIASES = new Map([
  ['workspace.proposeedit', 'workspace.proposeEdit'],
  ['workspace.applyproposededit', 'workspace.applyProposedEdit']
]);

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeLegacyToolName(name) {
  if (typeof name !== 'string') {
    return undefined;
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return undefined;
  }
  return LEGACY_TOOL_NAME_ALIASES.get(trimmed.toLowerCase()) ?? trimmed;
}

function isObjectRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickStringArg(input, names) {
  if (!isObjectRecord(input)) {
    return undefined;
  }
  for (const name of names) {
    const direct = input[name];
    if (typeof direct === 'string' && direct.trim().length > 0) {
      return direct;
    }
  }
  const nestedKeys = ['args', 'input', 'payload', 'params'];
  for (const nestedKey of nestedKeys) {
    const nested = input[nestedKey];
    if (!isObjectRecord(nested)) {
      continue;
    }
    for (const name of names) {
      const value = nested[name];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }
  }
  return undefined;
}

function pickIntegerArg(input, names) {
  if (!isObjectRecord(input)) {
    return undefined;
  }
  for (const name of names) {
    const direct = input[name];
    if (typeof direct === 'number' && Number.isInteger(direct)) {
      return direct;
    }
  }
  const nestedKeys = ['args', 'input', 'payload', 'params'];
  for (const nestedKey of nestedKeys) {
    const nested = input[nestedKey];
    if (!isObjectRecord(nested)) {
      continue;
    }
    for (const name of names) {
      const value = nested[name];
      if (typeof value === 'number' && Number.isInteger(value)) {
        return value;
      }
    }
  }
  return undefined;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
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

function buildWholeFileUpdatePatch(relativeFilePath, oldText, newText) {
  const normalizedPath = relativeFilePath.replace(/\\/g, '/');
  const toPatchLines = text => {
    if (text.length === 0) {
      return [];
    }
    const normalized = text.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    if (normalized.endsWith('\n') && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines;
  };
  const oldLines = toPatchLines(oldText);
  const newLines = toPatchLines(newText);
  return [
    '*** Begin Patch',
    `*** Update File: ${normalizedPath}`,
    '@@',
    ...oldLines.map(line => `-${line}`),
    ...newLines.map(line => `+${line}`),
    '*** End Patch'
  ].join('\n');
}

function normalizeHostEnvironment(hostEnvironment) {
  if (!hostEnvironment || typeof hostEnvironment !== 'object' || Array.isArray(hostEnvironment)) {
    return undefined;
  }
  const record = hostEnvironment;
  const preferredShellRaw = typeof record.preferredShell === 'string' ? record.preferredShell.trim().toLowerCase() : '';
  const preferredShell =
    preferredShellRaw === 'powershell' || preferredShellRaw === 'bash' || preferredShellRaw === 'sh'
      ? preferredShellRaw
      : undefined;
  const platform = typeof record.platform === 'string' ? record.platform.trim() : '';
  const arch = typeof record.arch === 'string' ? record.arch.trim() : '';
  const shellWrapperHint = typeof record.shellWrapperHint === 'string' ? record.shellWrapperHint.trim() : '';
  const isWindows =
    typeof record.isWindows === 'boolean'
      ? record.isWindows
      : platform.toLowerCase() === 'win32' || preferredShell === 'powershell';
  return {
    platform: platform || (isWindows ? 'win32' : process.platform),
    arch: arch || process.arch,
    preferredShell: preferredShell || (isWindows ? 'powershell' : 'bash'),
    shellWrapperHint: shellWrapperHint || (isWindows
      ? 'powershell -NoLogo -NoProfile -Command "<command>"'
      : 'bash -lc "<command>"'),
    isWindows
  };
}

const DEBUG_ENABLED =
  process.env.SPILLI_EXTERNAL_AGENT_DEBUG === '1' ||
  process.env.SPILLI_AGENT_RUNTIME_DEBUG === '1';

function debug(message, detail) {
  if (!DEBUG_ENABLED) {
    return;
  }
  const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
  console.log(`[spilli][external-agent][spilli-coder] ${message}${suffix}`);
}

const VALID_STATUS_PHASES = new Set([
  'planning',
  'waiting',
  'model',
  'tool',
  'working',
  'finalizing',
  'done',
  'error'
]);

function sanitizeStatusUpdate(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    return undefined;
  }
  const phase = typeof status.phase === 'string' ? status.phase.trim() : '';
  const message = typeof status.message === 'string' ? status.message.trim() : '';
  if (!VALID_STATUS_PHASES.has(phase) || !message) {
    return undefined;
  }
  const sanitized = { phase, message };
  if (typeof status.detail === 'string' && status.detail.trim()) {
    sanitized.detail = status.detail.trim();
  }
  if (typeof status.iteration === 'number' && Number.isFinite(status.iteration)) {
    sanitized.iteration = status.iteration;
  }
  if (typeof status.toolName === 'string' && status.toolName.trim()) {
    sanitized.toolName = status.toolName.trim();
  }
  if (typeof status.progress === 'number' && Number.isFinite(status.progress)) {
    sanitized.progress = Math.max(0, Math.min(1, status.progress));
  }
  if (status.metadata && typeof status.metadata === 'object' && !Array.isArray(status.metadata)) {
    sanitized.metadata = status.metadata;
  }
  return sanitized;
}

function emitStatus(hooks, runtimeContext, status) {
  const sanitized = sanitizeStatusUpdate(status);
  if (!sanitized) {
    return;
  }
  try {
    if (typeof hooks?.onStatus === 'function') {
      hooks.onStatus(sanitized);
    } else if (typeof runtimeContext?.reportStatus === 'function') {
      runtimeContext.reportStatus(sanitized);
    }
    debug('status emitted', {
      phase: sanitized.phase,
      message: sanitized.message,
      iteration: sanitized.iteration,
      toolName: sanitized.toolName
    });
  } catch (error) {
    debug('status emission failed', {
      phase: sanitized.phase,
      message: sanitized.message,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function displayIteration(iteration) {
  return Number.isFinite(iteration) ? iteration + 1 : undefined;
}

function tryParseJsonObject(candidate) {
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function extractJsonObjectCandidates(body) {
  const candidates = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (start < 0) {
      if (char === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        candidates.push(body.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function parseToolArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {};
  }
  const parsed = tryParseJsonObject(value.trim());
  return parsed ?? {};
}

function toToolCallEnvelope(record) {
  if (!record || typeof record !== 'object') {
    return undefined;
  }
  const responseFunctionName =
    record.type === 'function_call' ||
    typeof record.call_id === 'string' ||
    typeof record.arguments !== 'undefined'
      ? record.name
      : undefined;
  const toolName = normalizeLegacyToolName(record.toolName || responseFunctionName);
  if (!toolName) {
    return undefined;
  }
  const callId =
    typeof record.callId === 'string' && record.callId.trim().length > 0
      ? record.callId.trim()
      : typeof record.call_id === 'string' && record.call_id.trim().length > 0
        ? record.call_id.trim()
        : typeof record.id === 'string' && record.id.trim().length > 0
          ? record.id.trim()
      : `external-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const args = parseToolArguments(
    typeof record.args !== 'undefined'
      ? record.args
      : typeof record.arguments !== 'undefined'
        ? record.arguments
        : undefined
  );
  return { toolName, callId, args };
}

function collectToolCallsFromParsed(value, calls) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectToolCallsFromParsed(item, calls);
    }
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }

  const direct = toToolCallEnvelope(value);
  if (direct) {
    calls.push(direct);
  }

  if (value.function && typeof value.function === 'object' && !Array.isArray(value.function)) {
    const chatToolCall = toToolCallEnvelope({
      type: 'function_call',
      id: value.id,
      call_id: value.id,
      name: value.function.name,
      arguments: value.function.arguments
    });
    if (chatToolCall) {
      calls.push(chatToolCall);
    }
  }

  for (const key of ['toolCalls', 'tool_calls', 'output', 'items', 'choices']) {
    if (Array.isArray(value[key])) {
      collectToolCallsFromParsed(value[key], calls);
    }
  }
  if (value.item && typeof value.item === 'object') {
    collectToolCallsFromParsed(value.item, calls);
  }
  if (value.message && typeof value.message === 'object') {
    collectToolCallsFromParsed(value.message, calls);
  }
}

function parseToolCalls(raw, content) {
  const candidates = [];
  const trimmedRaw = asString(raw).trim();
  const trimmedContent = asString(content).trim();

  if (trimmedRaw) {
    candidates.push(trimmedRaw);
  }
  if (trimmedContent && trimmedContent !== trimmedRaw) {
    candidates.push(trimmedContent);
  }

  const calls = [];

  const jsonBlockRegex = /```json\s*([\s\S]*?)```/gi;
  for (const body of candidates) {
    let match;
    while ((match = jsonBlockRegex.exec(body)) !== null) {
      if (!match[1]) {
        continue;
      }
      const parsed = tryParseJsonObject(match[1].trim());
      if (!parsed) {
        continue;
      }
      collectToolCallsFromParsed(parsed, calls);
    }
  }

  for (const body of candidates) {
    for (const candidate of extractJsonObjectCandidates(body)) {
      const parsed = tryParseJsonObject(candidate);
      if (!parsed) {
        continue;
      }
      collectToolCallsFromParsed(parsed, calls);
    }
  }

  // Harmony raw often encodes tool calls as:
  // <|start|>assistant<|channel|>analysis to=<toolName> code<|message|>{ ...args... }<|call|>
  // Accept "call", "end", or "return" terminators to handle model differences.
  const harmonyToolRegex =
    /<\|start\|>assistant<\|channel\|>analysis\s+to=([^\s<]+)(?:\s+[^<\n]+)?<\|message\|>([\s\S]*?)(?:<\|(call|end|return)\|>|(?=<\|start\|>)|$)/g;
  if (trimmedRaw) {
    let match;
    while ((match = harmonyToolRegex.exec(trimmedRaw)) !== null) {
      const toolName = asString(match[1]).trim();
      const argPayload = asString(match[2]).trim();
      if (!toolName) {
        continue;
      }
      const cleanedArgPayload = argPayload
        .replace(/<\|(call|end|return)\|>\s*$/i, '')
        .trim();
      const parsedArgs = cleanedArgPayload.length > 0
        ? tryParseJsonObject(cleanedArgPayload)
        : {};
      if (cleanedArgPayload.length > 0 && !parsedArgs) {
        continue;
      }
      debug('parsed harmony tool candidate', {
        toolName,
        hasJsonArgs: Object.keys(parsedArgs).length > 0,
        payloadLength: cleanedArgPayload.length,
        terminator: asString(match[3]).trim() || undefined
      });
      calls.push({
        toolName: normalizeLegacyToolName(toolName),
        callId: `external-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        args: parsedArgs
      });
    }
  }

  // Rendered content can include a markdown hint:
  // - Call `container.exec` + adjacent ```json args block
  const markdownToolRegex = /Call\s+`([^`]+)`[\s\S]*?```json\s*([\s\S]*?)```/gi;
  if (trimmedContent) {
    let match;
    while ((match = markdownToolRegex.exec(trimmedContent)) !== null) {
      const toolName = asString(match[1]).trim();
      const argPayload = asString(match[2]).trim();
      if (!toolName) {
        continue;
      }
      const parsedArgs = argPayload.length > 0 ? tryParseJsonObject(argPayload) : {};
      if (argPayload.length > 0 && !parsedArgs) {
        continue;
      }
      calls.push({
        toolName: normalizeLegacyToolName(toolName),
        callId: `external-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        args: parsedArgs
      });
    }
  }

  // Backward compatibility: full-response raw/content might be a direct JSON envelope.
  for (const candidate of candidates) {
    const parsed = tryParseJsonObject(candidate);
    if (!parsed) {
      continue;
    }

    collectToolCallsFromParsed(parsed, calls);
  }

  const seen = new Set();
  const deduped = [];
  for (const call of calls) {
    const normalizedToolName = normalizeLegacyToolName(call.toolName);
    if (!normalizedToolName) {
      continue;
    }
    const argsKey = JSON.stringify(call.args ?? {});
    const key = `${normalizedToolName}|${argsKey}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({
      ...call,
      toolName: normalizedToolName,
      callId: asString(call.callId).trim() || `external-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    });
  }
  debug('parseToolCalls complete', {
    rawLength: trimmedRaw.length,
    contentLength: trimmedContent.length,
    detectedCalls: deduped.map(call => call.toolName)
  });
  return deduped;
}

class ExternalModelAdapter {
  constructor(runtimeContext) {
    this.runtimeContext = runtimeContext;
  }

  buildQuery(state) {
    const sections = [];
    sections.push([
      '## USER TASK',
      asString(state.userQuery)
    ].join('\n'));

    if (asString(state.conversationSummary)) {
      sections.push([
        '## CONVERSATION SUMMARY',
        asString(state.conversationSummary)
      ].join('\n'));
    }

    if (Array.isArray(state.recentMessages) && state.recentMessages.length > 0) {
      sections.push([
        '## RECENT MESSAGES',
        '```json',
        JSON.stringify(state.recentMessages.slice(-6), null, 2),
        '```'
      ].join('\n'));
    }

    if (state.initialContext && typeof state.initialContext === 'object') {
      sections.push([
        '## CURRENT CONTEXT',
        'These facts are already known. Use them directly; do not call tools just to rediscover them.',
        '```json',
        JSON.stringify(state.initialContext, null, 2),
        '```'
      ].join('\n'));
    }

    if (Array.isArray(state.toolResults) && state.toolResults.length > 0) {
      const observations = state.toolResults.slice(-8).map((result, index) => [
        `### COMPLETED TOOL OBSERVATION ${index + 1}`,
        `toolName: ${asString(result.toolName)}`,
        `callId: ${asString(result.callId)}`,
        `ok: ${result.ok === true ? 'true' : 'false'}`,
        result.ok === true ? 'result:' : 'error:',
        '```json',
        JSON.stringify(result.ok === true ? result.result : { error: result.error ?? null, result: result.result ?? null }, null, 2),
        '```'
      ].join('\n'));
      sections.push([
        '## COMPLETED TOOL RESULTS',
        'The following tool calls have ALREADY RUN. Treat each result as an observation. Do not repeat the same tool call merely to see its output.',
        ...observations
      ].join('\n\n'));
    }

    sections.push([
      '## NEXT ASSISTANT ACTION',
      'If the information needed to answer is present above, answer now using only those facts.',
      'If more information is required, emit exactly one valid tool call JSON object.'
    ].join('\n'));

    return sections.join('\n\n');
  }

  async parseToolCalls(raw, content, model) {
    if (typeof this.runtimeContext.parseToolCalls !== 'function') {
      return parseToolCalls(raw, content);
    }
    try {
      const parsed = await this.runtimeContext.parseToolCalls({ raw, content, model });
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      debug('extension parseToolCalls failed; falling back to local parser', {
        error: error instanceof Error ? error.message : String(error)
      });
      return parseToolCalls(raw, content);
    }
  }

  async runOnce(args) {
    const prompt = asString(args.state.systemPrompt);
    const query = this.buildQuery(args.state);

    if (typeof args.onModelRequest === 'function') {
      args.onModelRequest({
        iteration: args.iteration,
        prompt,
        query
      });
    }

    emitStatus(args, this.runtimeContext, {
      phase: 'model',
      message: 'Waiting for model response.',
      iteration: displayIteration(args.iteration)
    });

    const run = await this.runtimeContext.runModel({
      prompt,
      query,
      model: args.model,
      scope: args.scope,
      team: args.team
    });

    const raw = asString(run && run.raw);
    const content = asString(run && run.content);
    const isHarmony = Boolean(run && run.isHarmony);

    if (typeof args.onChunk === 'function') {
      args.onChunk({
        chunk: content || raw,
        raw,
        display: content || raw,
        isHarmony
      });
    }

    if (typeof args.onModelResponse === 'function') {
      args.onModelResponse({
        iteration: args.iteration,
        raw,
        content: content || raw,
        isHarmony
      });
    }

    emitStatus(args, this.runtimeContext, {
      phase: 'working',
      message: 'Inspecting model output for tool calls.',
      iteration: displayIteration(args.iteration)
    });
    const toolCalls = await this.parseToolCalls(raw, content, args.model);

    return {
      raw,
      content: content || raw,
      isHarmony,
      toolCalls
    };
  }
}

class ExternalContextCollector {
  currentHostEnvironment;
  currentWorkspaceRoot;

  setHostEnvironment(hostEnvironment) {
    this.currentHostEnvironment = normalizeHostEnvironment(hostEnvironment);
  }

  setWorkspaceRoot(workspaceRoot) {
    this.currentWorkspaceRoot = typeof workspaceRoot === 'string' && workspaceRoot.trim()
      ? workspaceRoot.trim()
      : undefined;
  }

  async collectInitialContext() {
    const context = {
      source: 'external-runtime',
      timestamp: new Date().toISOString()
    };
    if (this.currentWorkspaceRoot) {
      context.workspaceRoot = this.currentWorkspaceRoot;
    }
    if (this.currentHostEnvironment) {
      context.hostEnvironment = this.currentHostEnvironment;
    }
    return context;
  }
}

class ExternalToolProxy {
  constructor(runtimeContext) {
    this.runtimeContext = runtimeContext;
    this.legacyProposalCache = new Map();
  }

  getDefaultContextContracts() {
    return DEFAULT_CONTEXT_CONTRACTS;
  }

  getAlwaysAvailableContracts() {
    return ALWAYS_AVAILABLE_CONTRACTS;
  }

  resolveRequestedToolName(name) {
    return normalizeLegacyToolName(name);
  }

  getWorkspaceRoot() {
    const requestedRoot = typeof this.runtimeContext?.workspaceRoot === 'string'
      ? this.runtimeContext.workspaceRoot.trim()
      : '';
    return requestedRoot || process.cwd();
  }

  toToolFailure(call, error) {
    return {
      callId: call.callId,
      toolName: call.toolName,
      ok: false,
      result: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  toToolSuccess(call, result) {
    return {
      callId: call.callId,
      toolName: call.toolName,
      ok: true,
      result
    };
  }

  async runLegacyProposeEditCompatibility(call) {
    const args = isObjectRecord(call.args) ? call.args : {};
    const filePath = pickStringArg(args, ['file', 'path', 'filePath', 'filepath', 'uri', 'targetPath']);
    const replacement = pickStringArg(args, ['replacement', 'newText', 'text', 'content']);
    if (!filePath) {
      throw new Error(
        'workspace.proposeEdit compatibility mode requires "file". ' +
        'Use container.exec with an apply_patch heredoc for edits.'
      );
    }
    if (typeof replacement !== 'string') {
      throw new Error(
        'workspace.proposeEdit compatibility mode requires "replacement". ' +
        'Use container.exec with an apply_patch heredoc for edits.'
      );
    }
    const workspaceRoot = this.getWorkspaceRoot();
    const absolutePath = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(workspaceRoot, filePath);
    const relativeToRoot = path.relative(workspaceRoot, absolutePath);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      throw new Error('workspace.proposeEdit compatibility mode rejected path outside workspace root.');
    }
    const original = await fs.readFile(absolutePath, 'utf8');
    const lines = original.split('\n');
    const lineCount = Math.max(1, lines.length);
    const startLine = pickIntegerArg(args, ['startLine', 'line_start', 'start']) ?? 1;
    const endLine = pickIntegerArg(args, ['endLine', 'line_end', 'end']) ?? lineCount;
    if (startLine < 1 || endLine < startLine) {
      throw new Error('workspace.proposeEdit compatibility mode requires 1-based line ranges where endLine >= startLine.');
    }
    const endLineText = lines[clamp(endLine, 1, lineCount) - 1] ?? '';
    const startCharacter = pickIntegerArg(args, ['startCharacter', 'startChar', 'charStart']) ?? 0;
    const endCharacter = pickIntegerArg(args, ['endCharacter', 'endChar', 'charEnd']) ?? endLineText.length;
    const offsets = rangeToOffset(original, {
      startLine,
      startCharacter,
      endLine,
      endCharacter
    });
    const updated = `${original.slice(0, offsets.start)}${replacement}${original.slice(offsets.end)}`;
    if (updated === original) {
      return this.toToolSuccess(call, {
        compatibilityAlias: true,
        legacyTool: 'workspace.proposeEdit',
        applied: false,
        reason: 'no_content_change'
      });
    }
    const patchText = buildWholeFileUpdatePatch(relativeToRoot, original, updated);
    const applied = await applyPatchFromText(patchText, workspaceRoot);
    const proposalId = `legacy-proposal-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.legacyProposalCache.set(proposalId, {
      file: absolutePath,
      appliedAt: new Date().toISOString()
    });
    return this.toToolSuccess(call, {
      compatibilityAlias: true,
      legacyTool: 'workspace.proposeEdit',
      proposalId,
      approvalToken: 'compatibility-immediate-apply',
      applied: true,
      output: applied.output,
      summary: applied.summary,
      notes: [
        'Legacy compatibility mode applied the edit immediately.',
        'Prefer container.exec with apply_patch heredoc commands for future edits.'
      ]
    });
  }

  async runLegacyApplyProposedEditCompatibility(call) {
    const args = isObjectRecord(call.args) ? call.args : {};
    const proposalId = pickStringArg(args, ['proposalId']);
    if (!proposalId) {
      throw new Error('workspace.applyProposedEdit compatibility mode requires proposalId.');
    }
    const proposal = this.legacyProposalCache.get(proposalId);
    if (!proposal) {
      return this.toToolSuccess(call, {
        compatibilityAlias: true,
        legacyTool: 'workspace.applyProposedEdit',
        applied: false,
        proposalId,
        reason: 'proposal_not_found',
        guidance: 'Legacy compatibility mode applies edits during workspace.proposeEdit. Use container.exec with apply_patch for new edits.'
      });
    }
    return this.toToolSuccess(call, {
      compatibilityAlias: true,
      legacyTool: 'workspace.applyProposedEdit',
      applied: true,
      proposalId,
      file: proposal.file,
      reason: 'already_applied_by_compatibility_mode'
    });
  }

  async executeToolCall(call) {
    const normalizedToolName = normalizeLegacyToolName(call?.toolName);
    const normalizedCall = {
      toolName: normalizedToolName ?? asString(call?.toolName).trim(),
      callId: asString(call?.callId).trim() || `external-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      args: isObjectRecord(call?.args) ? call.args : {}
    };
    if (typeof this.runtimeContext.executeToolCall !== 'function') {
      return this.toToolFailure(
        normalizedCall,
        new Error('External agent runtime requires host-side executeToolCall support.')
      );
    }
    return this.runtimeContext.executeToolCall(normalizedCall);
  }
}

function normalizeHooks(hooks) {
  return {
    onChunk: typeof hooks?.onChunk === 'function' ? hooks.onChunk : () => {},
    onToolCall: typeof hooks?.onToolCall === 'function' ? hooks.onToolCall : () => {},
    onToolResult: typeof hooks?.onToolResult === 'function' ? hooks.onToolResult : () => {},
    onEditProposal: typeof hooks?.onEditProposal === 'function' ? hooks.onEditProposal : () => {},
    onModelRequest: typeof hooks?.onModelRequest === 'function' ? hooks.onModelRequest : () => {},
    onModelResponse: typeof hooks?.onModelResponse === 'function' ? hooks.onModelResponse : () => {},
    onStatus: typeof hooks?.onStatus === 'function'
      ? hooks.onStatus
      : typeof hooks?.reportStatus === 'function'
        ? hooks.reportStatus
        : undefined,
    token: hooks?.token
  };
}

function toPositiveInteger(value, fallback) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}


function createAgentRuntime(runtimeContext) {
  const contextCollector = new ExternalContextCollector();
  const loop = new AgentLoop(
    new ExternalModelAdapter(runtimeContext),
    new ExternalToolProxy(runtimeContext),
    contextCollector,
    {
      maxIterations: toPositiveInteger(process.env.SPILLI_AGENT_MAX_ITERATIONS, 8),
      toolTimeoutMs: toPositiveInteger(process.env.SPILLI_AGENT_TOOL_TIMEOUT_MS, 10000),
      maxConsecutiveRepeatedToolFailures: toPositiveInteger(
        process.env.SPILLI_AGENT_MAX_CONSECUTIVE_REPEATED_TOOL_FAILURES,
        3
      ),
      maxCompletionRequirementRetries: toPositiveInteger(
        process.env.SPILLI_AGENT_MAX_COMPLETION_REQUIREMENT_RETRIES,
        2
      )
    }
  );

  return {
    runTurn: (request, hooks) => {
      contextCollector.setHostEnvironment(request?.hostEnvironment);
      contextCollector.setWorkspaceRoot(runtimeContext?.workspaceRoot ?? process.env.WORKSPACE_ROOT);
      const normalizedHooks = normalizeHooks({
        ...hooks,
        reportStatus: runtimeContext?.reportStatus
      });
      return loop.runTurn(request, normalizedHooks);
    }
  };
}

module.exports = {
  createAgentRuntime
};

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentLoop = void 0;
const BASE_SYSTEM_PROMPT = [
    'You are a coding assistant running in a VS Code extension.',
    'If you need IDE/workspace information, emit Harmony tool calls.',
    'For tool calls, output JSON with {"toolName":"...","callId":"...","args":{...}}.',
    'Never claim a file has been modified unless a tool call returns success and confirms the applied change.'
].join('\n');
const EXECUTION_REQUIREMENTS_MARKER = /execution requirements/i;
const REQUIRED_OUTPUT_MARKER = /required output/i;
const DEFAULT_MAX_COMPLETION_REQUIREMENT_RETRIES = 2;
const MIN_SUBSTANTIVE_FINAL_RESPONSE_CHARS = 120;
const TOOL_USAGE_RULES = [
    'Rules:',
    '- Always put tool arguments inside the "args" object.',
    '- Do not emit non-JSON argument payloads.',
    '- Do not invent alternate key names when a key is listed above.',
    '- Use fully-qualified tool names from the contracts (for example "workspace.searchText").',
    '- Use workspace-relative paths when possible (for example "package.json"), but absolute paths are supported.',
    '- Reuse prior tool results. Do not repeat identical calls when required data is already available.',
    '- If workspace.readFile returns {"found": false, ...}, retry using one of the suggested paths instead of repeating the same bad path.',
    '- For precise edits after a range read, use returned numberedLines to map absolute file line numbers.',
    '- After a successful edit tool call on a file, re-read the next target range from that file before proposing another edit because line numbers may shift.',
    '- For YAML edits, preserve indentation-sensitive block structure and verify the final patch shape before finishing.',
    '- For indentation-sensitive files (.py, .yml, .yaml), preserve the exact leading whitespace of the block you replace.',
    '- Prefer container.exec with apply_patch heredoc commands for deterministic file edits.',
    '- If execution requirements explicitly name tools (for example container.exec), invoke those exact tools before finishing.',
    '- Use available workspace and shell tools intentionally; prefer stable, deterministic edits and verify outcomes after each change.',
    '- If hostEnvironment indicates Windows/PowerShell, write container.exec commands in PowerShell syntax and avoid bash-specific wrappers/assumptions.',
    '- When the prompt includes execution requirements or required output sections, the final response must be substantive and explicitly satisfy each requested output item.'
];
function formatToolContract(contract, index) {
    const lines = [`${index}) ${contract.name}`, `   args: ${contract.args}`, `   returns: ${contract.returns}`];
    if (contract.notes) {
        lines.push(`   notes: ${contract.notes}`);
    }
    return lines;
}
function buildToolArgumentSpecs(registry) {
    const deduped = new Map();
    for (const contract of registry.getDefaultContextContracts()) {
        deduped.set(contract.name, contract);
    }
    for (const contract of registry.getAlwaysAvailableContracts()) {
        deduped.set(contract.name, contract);
    }
    const contracts = [...deduped.values()].sort((a, b) => a.name.localeCompare(b.name));
    const lines = ['Tool contracts (JSON object only):'];
    let index = 1;
    for (const contract of contracts) {
        lines.push(...formatToolContract(contract, index));
        index += 1;
    }
    lines.push('Tool activation flow:', '- Start with the default contracts listed above.', '- If a needed tool is missing, call tools.searchContracts to discover the correct contract.', '- Call tools.enableTools with the selected tool names before invoking them.');
    lines.push(...TOOL_USAGE_RULES);
    return lines.join('\n');
}
function withTimeout(promise, timeoutMs, message) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return promise;
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        promise
            .then(value => {
            clearTimeout(timer);
            resolve(value);
        })
            .catch(err => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
function extractCompletionRequirements(query) {
    const hasExecutionRequirementsSection = EXECUTION_REQUIREMENTS_MARKER.test(query);
    const hasRequiredOutputSection = REQUIRED_OUTPUT_MARKER.test(query);
    const requiresDiffBlock = /```diff\b/i.test(query) ||
        /fenced\s+```diff\s*block/i.test(query) ||
        /diff\s*block/i.test(query);
    const requiresSubstantiveResponse = hasExecutionRequirementsSection || hasRequiredOutputSection;
    if (!requiresSubstantiveResponse && !requiresDiffBlock) {
        return undefined;
    }
    const requiredSuccessfulTools = new Set();
    const requirementLines = query.split(/\r?\n/).filter(line => /^\s*-\s+/.test(line));
    for (const line of requirementLines) {
        if (!/(use|call|invoke|required|must)/i.test(line)) {
            continue;
        }
        const toolNames = line.match(/\b(?:workspace|tools|ide|container)\.[A-Za-z][A-Za-z0-9_]*\b/g) ?? [];
        for (const toolName of toolNames) {
            requiredSuccessfulTools.add(toolName.toLowerCase());
        }
    }
    return {
        requiresDiffBlock,
        requiresSubstantiveResponse,
        requiredSuccessfulTools: [...requiredSuccessfulTools]
    };
}
function hasDiffBlock(content) {
    return /```diff\b[\s\S]*```/i.test(content);
}
function diffBlockIssue(content) {
    if (!hasDiffBlock(content)) {
        return 'a fenced ```diff patch block in the final response';
    }
    const diffBlocks = [...content.matchAll(/```diff\b([\s\S]*?)```/gi)].map(match => match[1] ?? '');
    const hasGitStyleDiff = diffBlocks.some(block => /(^|\n)\s*diff --git\s+/m.test(block) ||
        ((/(^|\n)\s*---\s+\S+/m.test(block)) && (/(^|\n)\s*\+\+\+\s+\S+/m.test(block))));
    if (hasGitStyleDiff) {
        return undefined;
    }
    const hasApplyPatchEnvelope = diffBlocks.some(block => /\*\*\*\s*Begin Patch\b/i.test(block));
    if (hasApplyPatchEnvelope) {
        return 'a git-style ```diff block (not apply_patch envelope syntax)';
    }
    return 'a git-style ```diff block with file headers (for example "diff --git", "---", and "+++")';
}
function isSubstantiveResponse(content) {
    const normalized = content.replace(/\s+/g, ' ').trim();
    if (normalized.length < MIN_SUBSTANTIVE_FINAL_RESPONSE_CHARS) {
        return false;
    }
    const nonEmptyLines = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
    return nonEmptyLines.length >= 2;
}
class AgentLoop {
    adapter;
    tools;
    contextCollector;
    options;
    constructor(adapter, tools, contextCollector, options) {
        this.adapter = adapter;
        this.tools = tools;
        this.contextCollector = contextCollector;
        this.options = options;
    }
    buildSystemPrompt(request, requirements) {
        const promptParts = [`${BASE_SYSTEM_PROMPT}\n${buildToolArgumentSpecs(this.tools)}`];
        if (request.hostEnvironment) {
            const env = request.hostEnvironment;
            promptParts.push([
                'Host execution environment:',
                `- platform: ${env.platform}`,
                `- arch: ${env.arch}`,
                `- preferredShell: ${env.preferredShell}`,
                `- shellWrapperHint: ${env.shellWrapperHint}`,
                `- isWindows: ${env.isWindows ? 'true' : 'false'}`
            ].join('\n'));
        }
        const completionRequirements = requirements ?? extractCompletionRequirements(request.query);
        if (completionRequirements) {
            const requirementLines = [
                'Execution requirement guardrails:',
                '- The user provided explicit execution requirements. Satisfy those requirements before ending the response.'
            ];
            if (completionRequirements.requiresDiffBlock) {
                requirementLines.push('- Final response must include a fenced ```diff block when requested.');
            }
            if (completionRequirements.requiresSubstantiveResponse) {
                requirementLines.push(`- Final response must be substantive (at least ${MIN_SUBSTANTIVE_FINAL_RESPONSE_CHARS} non-whitespace characters and more than one non-empty line).`);
            }
            requirementLines.push('- If execution requirements are not met yet, continue with tool calls instead of ending the response.');
            promptParts.push(requirementLines.join('\n'));
        }
        return promptParts.join('\n');
    }
    completionRequirementsIssue(requirements, state, content) {
        if (!requirements) {
            return undefined;
        }
        const gaps = [];
        if (requirements.requiresDiffBlock) {
            const issue = diffBlockIssue(content);
            if (issue) {
                gaps.push(issue);
            }
        }
        if (requirements.requiresSubstantiveResponse && !isSubstantiveResponse(content)) {
            gaps.push(`a substantive final response (${MIN_SUBSTANTIVE_FINAL_RESPONSE_CHARS}+ non-whitespace characters across multiple lines)`);
        }
        if (requirements.requiredSuccessfulTools.length > 0) {
            const successfulTools = new Set(state.toolResults
                .filter(item => item.ok)
                .map(item => {
                const resolved = this.tools.resolveRequestedToolName(item.toolName);
                return (resolved ?? item.toolName).toLowerCase();
            }));
            const missingTools = requirements.requiredSuccessfulTools
                .map(toolName => {
                const resolved = this.tools.resolveRequestedToolName(toolName);
                return (resolved ?? toolName).toLowerCase();
            })
                .filter(toolName => !successfulTools.has(toolName));
            if (missingTools.length > 0) {
                gaps.push(`successful tool calls for ${missingTools.join(', ')}`);
            }
        }
        if (gaps.length === 0) {
            return undefined;
        }
        return ('Execution requirements are not met yet: missing ' +
            gaps.join(', ') +
            '. Continue with tool calls and provide a complete patch response.');
    }
    async runTurn(request, callbacks) {
        const completionRequirements = extractCompletionRequirements(request.query);
        const collectedInitialContext = await this.contextCollector.collectInitialContext();
        const initialContext = collectedInitialContext && typeof collectedInitialContext === 'object'
            ? { ...collectedInitialContext }
            : {};
        if (request.hostEnvironment &&
            typeof request.hostEnvironment === 'object' &&
            !Array.isArray(request.hostEnvironment)) {
            initialContext.hostEnvironment = request.hostEnvironment;
        }
        const state = {
            systemPrompt: this.buildSystemPrompt(request, completionRequirements),
            userQuery: request.query,
            initialContext,
            toolResults: [],
            conversationSummary: request.conversationSummary,
            recentMessages: request.recentMessages ?? []
        };
        let finalRaw = '';
        let finalDisplay = '';
        let finalIsHarmony = false;
        const hasIterationLimit = Number.isFinite(this.options.maxIterations) && this.options.maxIterations > 0;
        const repeatedFailureLimit = Number.isFinite(this.options.maxConsecutiveRepeatedToolFailures)
            ? Math.max(1, this.options.maxConsecutiveRepeatedToolFailures)
            : 3;
        const maxCompletionRequirementRetries = Number.isFinite(this.options.maxCompletionRequirementRetries)
            ? Math.max(0, this.options.maxCompletionRequirementRetries)
            : Number.isFinite(this.options.maxBenchmarkCompletionRetries)
                ? Math.max(0, this.options.maxBenchmarkCompletionRetries)
                : DEFAULT_MAX_COMPLETION_REQUIREMENT_RETRIES;
        let lastFailureSignature;
        let consecutiveRepeatedFailures = 0;
        let completionRequirementRetries = 0;
        for (let iteration = 0; !hasIterationLimit || iteration < this.options.maxIterations; iteration += 1) {
            if (callbacks.token?.isCancellationRequested) {
                throw new Error('Request cancelled.');
            }
            const run = await this.adapter.runOnce({
                iteration,
                model: request.model,
                scope: request.scope,
                team: request.team,
                state,
                onChunk: callbacks.onChunk,
                onModelRequest: callbacks.onModelRequest,
                onModelResponse: callbacks.onModelResponse
            });
            finalRaw = run.raw;
            finalDisplay = run.content;
            finalIsHarmony = run.isHarmony;
            if (run.toolCalls.length === 0) {
                const completionIssue = this.completionRequirementsIssue(completionRequirements, state, finalDisplay);
                if (completionIssue) {
                    if (completionRequirementRetries >= maxCompletionRequirementRetries) {
                        return {
                            raw: finalRaw,
                            content: finalDisplay ? `${finalDisplay}\n\n${completionIssue}` : completionIssue,
                            isHarmony: finalIsHarmony
                        };
                    }
                    completionRequirementRetries += 1;
                    state.toolResults.push({
                        callId: `agent:completion-requirements-${completionRequirementRetries}`,
                        toolName: 'agent.completion',
                        ok: false,
                        result: null,
                        error: completionIssue
                    });
                    continue;
                }
                return {
                    raw: finalRaw,
                    content: finalDisplay,
                    isHarmony: finalIsHarmony
                };
            }
            completionRequirementRetries = 0;
            for (const call of run.toolCalls) {
                callbacks.onToolCall(call);
                const result = await withTimeout(this.tools.executeToolCall(call), this.options.toolTimeoutMs, `Tool timed out: ${call.toolName}`);
                callbacks.onToolResult(result);
                state.toolResults.push(result);
                const effectiveToolName = result.toolName;
                if (!result.ok) {
                    const signature = `${effectiveToolName}|${result.error ?? ''}`;
                    if (signature === lastFailureSignature) {
                        consecutiveRepeatedFailures += 1;
                    }
                    else {
                        lastFailureSignature = signature;
                        consecutiveRepeatedFailures = 1;
                    }
                    if (consecutiveRepeatedFailures >= repeatedFailureLimit) {
                        const guidance = 'Agent loop stopped after repeated identical tool failures. Switch to available workspace tools (for example workspace.readFile, workspace.searchText, container.exec) instead of retrying the same unavailable tool.';
                        state.toolResults.push({
                            callId: 'agent:repeated-tool-failure',
                            toolName: 'agent.loop',
                            ok: false,
                            result: null,
                            error: guidance
                        });
                        return {
                            raw: finalRaw,
                            content: finalDisplay ? `${finalDisplay}\n\n${guidance}` : guidance,
                            isHarmony: finalIsHarmony
                        };
                    }
                }
                else {
                    lastFailureSignature = undefined;
                    consecutiveRepeatedFailures = 0;
                }
                if (result.ok && effectiveToolName === 'tools.enableTools') {
                    state.systemPrompt = this.buildSystemPrompt(request, completionRequirements);
                }
            }
        }
        if (hasIterationLimit) {
            state.toolResults.push({
                callId: 'agent:max-iterations',
                toolName: 'agent.loop',
                ok: false,
                result: null,
                error: `Maximum iterations (${this.options.maxIterations}) reached.`
            });
        }
        const completionIssue = this.completionRequirementsIssue(completionRequirements, state, finalDisplay);
        if (completionIssue) {
            return {
                raw: finalRaw,
                content: finalDisplay ? `${finalDisplay}\n\n${completionIssue}` : completionIssue,
                isHarmony: finalIsHarmony
            };
        }
        return {
            raw: finalRaw,
            content: finalDisplay,
            isHarmony: finalIsHarmony
        };
    }
}
exports.AgentLoop = AgentLoop;
//# sourceMappingURL=agentLoop.js.map

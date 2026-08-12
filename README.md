# spilli-coder

`spilli-coder` is a privacy-preserving coding agent runtime for the decentralized SpiLLI AI network. It delivers cloud-like scalability while keeping your code and data under your control, not repurposed by third-party AI vendors for training, validation, or any other use.

This agent is designed to run through the SpiLLI VS Code extension, which provides the UI and lifecycle management. From the extension's **Manage Agents** window, you can install, sync, and activate this repo in a few clicks.

## What This Repo Provides

- A working external coding-agent loop (`agentLoop.js`)
- A SpiLLI agent manifest (`spilli-agent.json`)
- Host-side workspace/IDE/container tool compatibility through the SpiLLI extension runtime
- A practical baseline you can fork and customize for your own agent

## Quick Start (Use This Agent)

1. Open VS Code with the SpiLLI extension installed.
2. Open SpiLLI chat and launch **Manage Agents**.
3. Paste this repo URL and install it:
   - `https://github.com/synaptrixai/spilli-coder.git`
4. Activate the installed agent.

## Build Your Own Agent (Fork + Adapt)

1. Fork this repository.
2. Update `spilli-agent.json`:
   - Set a unique `agent.id`
   - Set your own `agent.name` and `agent.description`
   - Keep `agent.loopEntry` pointing to your runtime entry file
3. Customize your agent behavior in `agentLoop.js` (or your own loop entry file).
4. If needed, add custom agent-only tool modules and list them in `localToolEntries`.
5. Push your fork to GitHub.
6. In SpiLLI extension **Manage Agents**, install your fork URL and activate it.

## Tool Runtime Model

Built-in coding tools such as `ide.getActiveEditorContext`, `workspace.readFile`,
`workspace.proposeEdit`, and `container.exec` run on the VS Code extension host side.
The external agent calls them through the runtime SDK via `context.executeToolCall(...)`;
do not duplicate those built-ins in `localToolEntries`.

## Conversation Context

The extension treats a SpiLLI SDK session as a reusable network/model allocation and uses `spilli_context.context_id` to isolate chat histories in SpiLLIHost. This agent sends the current task and workspace facts only on the first model call of a turn. Later calls contain only tool results completed since the preceding model call; they do not replay the original task, conversation summaries, recent messages, or older tool results.

Fresh sessions, resource switches, resets, and host context misses are hydrated by the extension from the authoritative chat snapshot. Strict continuations are sent as deltas. Main chats and sub-agents may share an allocation, but each must retain the distinct context identity and revision supplied by the extension; this runtime does not keep a model-global transcript.

Use `localToolEntries` only for extra agent-specific tools that are not already provided
by `src/agent/tooling` in the extension.

## Adding New Local Tools

To add custom tools, use this pattern:

1. Create a JS module (for example `tools/myTools.js`) that exports a tool module with an `id` and a `tools` array.
2. For each tool, define:
   - `contract` (name, description, args, returns)
   - `createTool` (returns an object with `invoke(input)`)
3. Add your new module path to `localToolEntries` in `spilli-agent.json`.
4. Update your agent loop instructions/prompts (in `agentLoop.js`) so the model knows when to call the new tool.

Example shape:

```js
'use strict';

function createMyTool() {
  return {
    invoke: async (input) => {
      return JSON.stringify({ ok: true, input });
    }
  };
}

const toolModule = {
  id: 'my-custom-tools',
  tools: [
    {
      contract: {
        name: 'mytool.run',
        description: 'Runs my custom workflow.',
        args: '{"task": string}',
        returns: '{"ok": boolean, "result"?: string}',
        includeByDefault: true,
        keywords: ['custom', 'workflow']
      },
      createTool: createMyTool
    }
  ]
};

module.exports = {
  default: toolModule,
  toolModule
};
```

Then add only your custom module to the manifest:

```json
"localToolEntries": [
  "tools/myTools.js"
]
```

## Sample Prompt for AI Assistants

Use this with Claude, Codex, or similar assistants to adapt this repo into a tailored agent while keeping SpiLLI compatibility:

Share your repo README link as context as well (for example: `https://github.com/<your-org>/<your-agent-repo>/blob/main/README.md`).

```text
You are helping me customize a fork of the spilli-coder repository into a new specialized coding agent that can be installed through the SpiLLI VS Code extension (Manage Agents UI).

Goals:
- Keep this repo compatible as an external SpiLLI agent repo.
- Preserve required manifest/runtime wiring so it can be installed by repo URL.
- Adapt behavior for this purpose: <DESCRIBE YOUR AGENT PURPOSE>.
- Add or modify tools needed for that purpose.

Repository constraints:
- `spilli-agent.json` must remain valid.
- Keep or correctly update: `agent.id`, `agent.name`, `agent.description`, `agent.loopEntry`, and `localToolEntries`.
- Implement behavior changes primarily in `agentLoop.js` (or the file referenced by `agent.loopEntry`).
- For new agent-specific tools, create a local tool module with proper contract + invoke implementation, then register it in `localToolEntries`.
- Do not register duplicated built-in extension tools from `src/agent/tooling`; the external runtime reaches them through the host SDK.
- Do not add extension-internal assumptions; keep this repo self-contained as an external agent runtime.

What I want from you:
1. Use my repo README link as additional context before making changes.
2. Propose a short implementation plan.
3. Make concrete file edits in this repo.
4. Explain exactly what changed and why.
5. Provide a quick validation checklist before I push.

Output requirements:
- Show updated `spilli-agent.json` values I should use.
- Show the key prompt/logic changes in the agent loop.
- List each new/updated tool contract and where it is registered.
- Keep changes minimal, readable, and production-safe.
```

Tips:
- Be specific in `<DESCRIBE YOUR AGENT PURPOSE>` (for example: test-writing agent, refactor assistant, API migration helper, security review assistant, docs-maintainer agent).
- Ask your AI assistant to keep edits small and iterative so you can test each change quickly.

## Minimal Manifest Notes

Your repo should include a valid `spilli-agent.json` with:

- `schemaVersion`
- `runtimeApiVersion`
- `agent.id`, `agent.name`, `agent.apiVersion`, `agent.loopEntry`
- `localToolEntries` (empty unless you add custom tools beyond the extension host-side built-ins)

## Design Goals

- Privacy-first coding workflows
- Decentralized model/runtime compatibility via SpiLLI
- Repo-level agent portability: anyone can fork, modify, and install via URL

## License

See [LICENSE](./LICENSE).

# spilli-coder

`spilli-coder` is a privacy-preserving coding agent runtime for the decentralized SpiLLI AI network. It delivers cloud-like scalability while keeping your code and data under your control, not repurposed by third-party AI vendors for training, validation, or any other use.

This agent is designed to run through the SpiLLI VS Code extension, which provides the UI and lifecycle management. From the extension's **Manage Agents** window, you can install, sync, and activate this repo in a few clicks.

## What This Repo Provides

- A working external coding-agent loop (`agentLoop.js`)
- A SpiLLI agent manifest (`spilli-agent.json`)
- Tool entrypoints for workspace/IDE/container-style operations
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
4. If needed, add or replace local tool modules and list them in `localToolEntries`.
5. Push your fork to GitHub.
6. In SpiLLI extension **Manage Agents**, install your fork URL and activate it.

## Minimal Manifest Notes

Your repo should include a valid `spilli-agent.json` with:

- `schemaVersion`
- `runtimeApiVersion`
- `agent.id`, `agent.name`, `agent.apiVersion`, `agent.loopEntry`
- `localToolEntries` (when used)

## Design Goals

- Privacy-first coding workflows
- Decentralized model/runtime compatibility via SpiLLI
- Repo-level agent portability: anyone can fork, modify, and install via URL

## License

See [LICENSE](./LICENSE).

#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const applyPatchCore_1 = require("../applyPatchCore");
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString('utf8');
}
async function main() {
    const input = await readStdin();
    const result = await (0, applyPatchCore_1.applyPatchFromText)(input, process.cwd());
    process.stdout.write(`${result.output}\n`);
}
void main().catch(err => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
});
//# sourceMappingURL=applyPatchCli.js.map
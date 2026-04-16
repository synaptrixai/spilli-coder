'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createAgentRuntime } = require('../agentLoop');
const shared = require('../tools/agent-tooling/shared');
const containerTools = require('../tools/agent-tooling/tools/containerTools').default;

test('legacy workspace.proposeEdit compatibility applies edit immediately', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'spilli-compat-'));
  const filePath = path.join(workspaceRoot, 'LaunchCheckList.md');
  await fs.writeFile(filePath, 'Line 1\n[]\n', 'utf8');

  let modelCalls = 0;
  let forwardedCalls = 0;
  const runtime = createAgentRuntime({
    workspaceRoot,
    runModel: async () => {
      modelCalls += 1;
      if (modelCalls === 1) {
        const payload = {
          toolName: 'workspace.proposeEdit',
          callId: 'call-1',
          args: {
            file: 'LaunchCheckList.md',
            startLine: 2,
            startCharacter: 1,
            endLine: 2,
            endCharacter: 1,
            replacement: 'X'
          }
        };
        const raw = JSON.stringify(payload);
        return { raw, content: raw, isHarmony: false };
      }
      return { raw: 'done', content: 'done', isHarmony: false };
    },
    executeToolCall: async call => {
      forwardedCalls += 1;
      return {
        callId: call.callId,
        toolName: call.toolName,
        ok: true,
        result: { forwarded: true }
      };
    }
  });

  await runtime.runTurn({ query: 'insert X in []', model: 'test-model' }, {});
  const updated = await fs.readFile(filePath, 'utf8');

  assert.equal(updated, 'Line 1\n[X]\n');
  assert.equal(forwardedCalls, 0);
});

test('invalid markdown json tool payload is ignored instead of executing empty container.exec', async () => {
  let modelCalls = 0;
  let forwardedCalls = 0;
  const runtime = createAgentRuntime({
    runModel: async () => {
      modelCalls += 1;
      if (modelCalls === 1) {
        const content = [
          '- Call `container.exec` + adjacent ```json args block',
          '```json',
          '{bad json}',
          '```'
        ].join('\n');
        return { raw: content, content, isHarmony: false };
      }
      return { raw: 'done', content: 'done', isHarmony: false };
    },
    executeToolCall: async call => {
      forwardedCalls += 1;
      return {
        callId: call.callId,
        toolName: call.toolName,
        ok: true,
        result: { forwarded: true }
      };
    }
  });

  const result = await runtime.runTurn({ query: 'noop', model: 'test-model' }, {});

  assert.equal(forwardedCalls, 0);
  assert.ok(result.content.includes('container.exec'));
});

test('workspace boundary checks do not allow sibling prefix paths', () => {
  const root = '/tmp/workspace';
  const sibling = '/tmp/workspace-other/file.txt';
  assert.equal(shared.isInsideWorkspace(sibling, root), false);
});

test('container command key aliases are accepted from nested args', () => {
  const value = shared.pickShellCommandArg({ args: { commandLine: 'echo hi' } });
  assert.equal(shared.parseShellCommandArg(value), 'echo hi');
});

test('container.exec returns soft error for missing cmd payload instead of throwing', async () => {
  const tool = containerTools.tools[0].createTool({ workspaceRoot: process.cwd() });
  const raw = await tool.invoke({});
  const result = JSON.parse(raw);

  assert.equal(result.ok, false);
  assert.equal(result.softError, true);
  assert.equal(result.softErrorKind, 'invalid_command_payload');
  assert.match(result.guidance, /non-empty "cmd"/i);
});

test('container.exec rejects suspicious channel marker commands', async () => {
  const tool = containerTools.tools[0].createTool({ workspaceRoot: process.cwd() });
  const raw = await tool.invoke({ cmd: 'analysis' });
  const result = JSON.parse(raw);

  assert.equal(result.ok, false);
  assert.equal(result.softError, true);
  assert.equal(result.softErrorKind, 'invalid_command_payload');
  assert.match(result.stderr, /Rejected suspicious shell command/i);
});

test('container.exec soft-failure classifier detects missing python runtime', () => {
  const { classifyContainerExecSoftFailure } = require('../tools/agent-tooling/tools/containerTools');
  const softFailure = classifyContainerExecSoftFailure('python -m pytest -q', 127, '/bin/sh: 1: python: not found');

  assert.equal(softFailure?.kind, 'missing_python_runtime');
  assert.equal(softFailure?.missingCommand, 'python');
});

test('container.exec derives workspace suggestion for basename-only missing file errors', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'spilli-container-path-'));
  const nestedDir = path.join(workspaceRoot, 'astropy', 'io', 'fits');
  await fs.mkdir(nestedDir, { recursive: true });
  await fs.writeFile(path.join(nestedDir, 'fitsrec.py'), '# test\n', 'utf8');
  const tool = containerTools.tools[0].createTool({ workspaceRoot });

  const raw = await tool.invoke({ cmd: 'sed -n "1p" fitsrec.py' });
  const result = JSON.parse(raw);

  assert.equal(result.missingPath, 'fitsrec.py');
  assert.equal(result.suggestedPath, 'astropy/io/fits/fitsrec.py');
  assert.equal(result.ok, true);
  assert.equal(result.autoRecoveredPath, true);
});

test('container.exec recovers cwd when relative cwd redundantly includes workspace basename', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'spilli-cwd-recover-'));
  await fs.writeFile(path.join(workspaceRoot, 'marker.txt'), 'ok\n', 'utf8');
  const tool = containerTools.tools[0].createTool({ workspaceRoot });
  const workspaceBase = path.basename(workspaceRoot);

  const raw = await tool.invoke({ cmd: 'cat marker.txt', cwd: `${workspaceBase}` });
  const result = JSON.parse(raw);

  assert.equal(result.ok, true);
  assert.equal(result.stdout.trim(), 'ok');
  assert.equal(result.cwd, workspaceRoot);
});

test('container.exec retries with suggested workspace-relative path for missing file', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'spilli-path-retry-'));
  await fs.mkdir(path.join(workspaceRoot, 'services'), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, 'services', 'stripeCatalog.js'), 'module.exports = 1;\n', 'utf8');
  const tool = containerTools.tools[0].createTool({ workspaceRoot });

  const raw = await tool.invoke({ cmd: 'sed -n "1p" src/services/stripeCatalog.js' });
  const result = JSON.parse(raw);

  assert.equal(result.ok, true);
  assert.equal(result.autoRecoveredPath, true);
  assert.equal(result.suggestedPath, 'services/stripeCatalog.js');
  assert.match(result.stdout, /module\.exports = 1;/);
});

test('container.exec apply_patch updates existing file when cwd path is redundantly prefixed', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'spilli-apply-patch-update-'));
  await fs.mkdir(path.join(workspaceRoot, 'src', 'routes'), { recursive: true });
  const indexPath = path.join(workspaceRoot, 'src', 'index.js');
  await fs.writeFile(indexPath, 'module.exports = "before";\n', 'utf8');
  const tool = containerTools.tools[0].createTool({ workspaceRoot });

  const patch = [
    'apply_patch <<\'PATCH\'',
    '*** Begin Patch',
    '*** Update File: src/index.js',
    '@@',
    '-module.exports = "before";',
    '+module.exports = "after";',
    '*** End Patch',
    'PATCH'
  ].join('\n');
  const raw = await tool.invoke({ cmd: patch, cwd: 'src' });
  const result = JSON.parse(raw);

  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(indexPath, 'utf8'), 'module.exports = "after";\n');
  await assert.rejects(
    fs.access(path.join(workspaceRoot, 'src', 'src', 'index.js')),
    /ENOENT/
  );
});

test('container.exec apply_patch add-file reuses cwd directories instead of creating nested cwd prefix', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'spilli-apply-patch-add-'));
  await fs.mkdir(path.join(workspaceRoot, 'src', 'routes'), { recursive: true });
  const tool = containerTools.tools[0].createTool({ workspaceRoot });

  const patch = [
    'apply_patch <<\'PATCH\'',
    '*** Begin Patch',
    '*** Add File: src/routes/catalog.js',
    '+module.exports = { ok: true };',
    '*** End Patch',
    'PATCH'
  ].join('\n');
  const raw = await tool.invoke({ cmd: patch, cwd: 'src' });
  const result = JSON.parse(raw);

  const expectedPath = path.join(workspaceRoot, 'src', 'routes', 'catalog.js');
  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(expectedPath, 'utf8'), 'module.exports = { ok: true };');
  await assert.rejects(
    fs.access(path.join(workspaceRoot, 'src', 'src', 'routes', 'catalog.js')),
    /ENOENT/
  );
});

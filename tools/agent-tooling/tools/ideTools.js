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
const vscode = __importStar(require("vscode"));
const shared_1 = require("../shared");
const ideTools = {
    id: 'ide-tools',
    tools: [
        {
            contract: {
                name: 'ide.getActiveEditorContext',
                description: 'Get active editor file, language, selection, and visible range.',
                args: '{}',
                returns: '{"active": boolean, "file"?: string, "languageId"?: string, "selection"?: {...}, "visibleRange"?: {...}}',
                notes: 'selection/visibleRange line values are 1-based. character values are 0-based.',
                includeByDefault: true,
                keywords: ['editor', 'selection', 'cursor', 'visible range']
            },
            createTool: () => (0, shared_1.createTool)('ide.getActiveEditorContext', async () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    return JSON.stringify({ active: false });
                }
                return JSON.stringify({
                    active: true,
                    file: editor.document.uri.fsPath,
                    languageId: editor.document.languageId,
                    selection: {
                        start: {
                            line: editor.selection.start.line + 1,
                            character: editor.selection.start.character
                        },
                        end: {
                            line: editor.selection.end.line + 1,
                            character: editor.selection.end.character
                        }
                    },
                    visibleRange: {
                        start: {
                            line: (editor.visibleRanges[0]?.start.line ?? editor.selection.start.line) + 1,
                            character: editor.visibleRanges[0]?.start.character ?? editor.selection.start.character
                        },
                        end: {
                            line: (editor.visibleRanges[0]?.end.line ?? editor.selection.end.line) + 1,
                            character: editor.visibleRanges[0]?.end.character ?? editor.selection.end.character
                        }
                    }
                });
            })
        },
        {
            contract: {
                name: 'ide.getSelectionText',
                description: 'Get selected text from the active editor.',
                args: '{}',
                returns: '{"text": string, "hasSelection": boolean}',
                includeByDefault: true,
                keywords: ['selection', 'highlight', 'active editor']
            },
            createTool: () => (0, shared_1.createTool)('ide.getSelectionText', async () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    return JSON.stringify({ text: '', hasSelection: false });
                }
                const text = editor.document.getText(editor.selection);
                return JSON.stringify({
                    text,
                    hasSelection: !editor.selection.isEmpty
                });
            })
        },
        {
            contract: {
                name: 'ide.getDiagnostics',
                description: 'Get diagnostics for active file or requested file.',
                args: '{"file"?: string}',
                returns: '{"file": string, "diagnostics": Array<...>}',
                notes: 'diagnostic range line values are 1-based. character values are 0-based.',
                includeByDefault: true,
                keywords: ['errors', 'warnings', 'problems', 'diagnostics']
            },
            createTool: context => (0, shared_1.createTool)('ide.getDiagnostics', async (input) => {
                const maybeFile = typeof input.file === 'string' ? input.file : undefined;
                let targetUri;
                if (maybeFile) {
                    targetUri = vscode.Uri.file((0, shared_1.normalizeInWorkspace)(maybeFile, context.workspaceRoot));
                }
                else {
                    targetUri = vscode.window.activeTextEditor?.document.uri;
                }
                if (!targetUri) {
                    return JSON.stringify({ diagnostics: [] });
                }
                const diagnostics = vscode.languages
                    .getDiagnostics(targetUri)
                    .slice(0, context.maxDiagnostics)
                    .map(diag => ({
                    message: diag.message,
                    severity: diag.severity,
                    source: diag.source,
                    range: {
                        start: { line: diag.range.start.line + 1, character: diag.range.start.character },
                        end: { line: diag.range.end.line + 1, character: diag.range.end.character }
                    }
                }));
                return JSON.stringify({ file: targetUri.fsPath, diagnostics });
            })
        }
    ]
};
exports.default = ideTools;
//# sourceMappingURL=ideTools.js.map
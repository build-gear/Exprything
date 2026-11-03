#!/usr/bin/env node
// node:sqlite still prints an ExperimentalWarning; keep stdout/stderr clean (MCP speaks over stdio).
process.removeAllListeners('warning');
const { register } = await import('tsx/esm/api');
register();
await import('../src/main.ts');

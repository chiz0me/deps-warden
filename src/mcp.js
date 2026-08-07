#!/usr/bin/env node

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createDepsWardenMcpServer } from './mcpServer.js';

serveStdio(() => createDepsWardenMcpServer(), {
  onerror: error => process.stderr.write(`deps-warden MCP error: ${error.message}\n`),
});

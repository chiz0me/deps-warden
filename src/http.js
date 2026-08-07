#!/usr/bin/env node

import { listenScanHttpServer } from './lib/httpServer.js';

try {
  const server = await listenScanHttpServer();
  const address = server.address();
  process.stderr.write(`deps-warden HTTP scanner listening on ${address.address}:${address.port}\n`);
} catch (error) {
  process.stderr.write(`deps-warden HTTP scanner error: ${error.message}\n`);
  process.exitCode = 1;
}

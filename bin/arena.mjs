#!/usr/bin/env node
import { main } from '../src/cli.mjs';

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`arena: ${e.message}\n`);
  process.exit(1);
});

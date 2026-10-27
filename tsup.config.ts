import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    clean: false,
    splitting: false,
    sourcemap: false,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    // The guard is copied into user projects, so it must be one standalone file
    // with every dependency bundled in.
    entry: { guard: 'src/guard/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    clean: false,
    splitting: false,
    sourcemap: false,
    noExternal: [/.*/],
    outExtension: () => ({ js: '.mjs' }),
  },
]);

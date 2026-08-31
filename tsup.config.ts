import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/worker.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  sourcemap: true,
  // Native module — resolved at runtime from node_modules, never bundled.
  external: ['better-sqlite3'],
  noExternal: [],
});

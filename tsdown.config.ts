/**
 * Two surfaces, two bundles.
 *
 * - Host: ESM for Node. Every dependency stays external so the plugin shares
 *   the running installation's copies of cordis / schemastery / semver.
 * - Client: CJS for the DSH browser module loader. The loader evaluates a
 *   factory that receives `require`; the banner/footer below turn the CJS
 *   bundle into the `window.__ModuleLoader__.load({ id, factory })` envelope
 *   the client expects.
 */
import { defineConfig } from 'tsdown'

const shared = {
  sourcemap: true,
  dts: false,
  clean: false,
  target: 'node22',
}

export default defineConfig([
  {
    ...shared,
    name: 'host',
    entry: {
      index: 'src/index.ts',
      'typert.host': 'src/typert/host.ts',
      'typert.remote-client': 'src/typert/remote.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    external: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-atomic-write',
      '@deepseek-ai/dsh-home-paths',
      '@deepseek-ai/dsh-typert-protocol',
      '@deepseek-ai/schemastery',
      'semver',
      'zod',
    ],
  },
  {
    name: 'client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    dts: false,
    external: ['react', 'react-dom', 'react/jsx-runtime', 'zod'],
    outputOptions: {
      banner:
        'window.__ModuleLoader__.load({ id: "@your-scope/dsh-update", factory: (require) => { var module = { exports: {} }; var exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
      footer: 'return module.exports; } });',
    },
  },
])

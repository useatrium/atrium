import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// Renderer is intentionally omitted: the UI is the @atrium/web build, served by
// the main process over a privileged `app://` scheme (secure context, so
// getUserMedia / LiveKit work — file:// would block the mic). electron-vite only
// builds the main + preload processes here.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') } },
    },
  },
});

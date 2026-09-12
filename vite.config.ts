import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

export default defineConfig({
  base: '/panbattle-play/',
  build: {
    outDir: 'dist-3d',
    emptyOutDir: true,
    target: ['es2022', 'safari16'],
    sourcemap: false,
    copyPublicDir: false,
    rollupOptions: { output: { manualChunks: { three: ['three', 'three/addons/loaders/GLTFLoader.js'] } } },
  },
  plugins: [{ name: 'mvp-assets', generateBundle() {
    for (const name of ['shokupan', 'francepan', 'croissant']) this.emitFile({ type: 'asset', fileName: `assets/models/${name}.glb`, source: readFileSync(`public/assets/models/${name}.glb`) });
    this.emitFile({ type: 'asset', fileName: 'sw.js', source: readFileSync('scripts/retire-sw.js') });
  } }],
  test: {
    exclude: ['node_modules/**', 'e2e/**', 'dist/**', 'dist-3d/**', 'tmp/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/input/**', 'src/battle/**', 'src/data/**', 'src/core/game-loop.ts', 'src/mvp/battle.ts', 'src/mvp/motion.ts', 'src/mvp/save.ts'],
    },
  },
});

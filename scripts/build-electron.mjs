/**
 * Electron 壳构建（P0-A #1）
 *
 * esbuild 打包 main / preload 为 CJS：
 *  - main：format=cjs，external electron；目标 Node（ELECTRON_RUN_AS_NODE 亦用同一运行时）
 *  - preload：sandbox=true 只支持 CJS preload
 *
 * 产物：electron/build/main.cjs、electron/build/preload/preload.cjs
 */
import { build } from 'esbuild';
import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '..', 'electron', 'build');

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, 'preload'), { recursive: true });

  const shared = {
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
    sourcemap: 'inline',
    logLevel: 'info',
  };

  await build({
    ...shared,
    entryPoints: [path.resolve(__dirname, '..', 'electron', 'main', 'index.ts')],
    outfile: path.join(outDir, 'main.cjs'),
  });

  await build({
    ...shared,
    entryPoints: [path.resolve(__dirname, '..', 'electron', 'preload', 'preload.ts')],
    outfile: path.join(outDir, 'preload', 'preload.cjs'),
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

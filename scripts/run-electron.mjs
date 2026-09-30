/**
 * Electron 启动器（dev:desktop / desktop:prod 共用）
 *
 * 职责：剥离子进程运行时变量（ELECTRON_RUN_AS_NODE 等），保证启动的是
 * 完整 Electron 应用而不是退化成纯 Node——本仓库的 Supervisor 会显式给
 * Node 子进程设置 ELECTRON_RUN_AS_NODE=1，若外层 shell 遗留该变量会污染启动。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function electronBinary() {
  const candidates = [
    path.join(projectRoot, 'node_modules', '.bin', 'electron'),
    path.join(projectRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('未找到 Electron 可执行文件（先执行 bun install）');
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary(), args, { cwd: projectRoot, env, stdio: 'inherit' });
child.on('close', (code, signal) => {
  if (code === null && signal) {
    console.error(`[run-electron] Electron 以信号 ${signal} 退出`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});

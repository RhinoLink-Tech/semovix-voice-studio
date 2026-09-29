/**
 * P0-B #29 发布脚本：构建 → 精简运行面 → electron-builder → SHA256SUMS → 更新清单
 *
 * 用法：
 *   node scripts/release.mjs --dir   # 仅产出解包 .app（本机结构验证，不出安装包）
 *   node scripts/release.mjs --mac   # DMG（arm64 + x64）
 *   node scripts/release.mjs --win   # NSIS（建议在 Windows 构建机执行）
 *
 * 签名可选（如实，不伪装）：
 *   mac 检测 CSC_LINK + CSC_KEY_PASSWORD；win 检测 WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD。
 *   缺失 → 显式禁用签名（-c.mac.identity=null / 跳过 win 签名），
 *   并在 release/latest.json 的 signing 段标注 "unsigned"。
 *
 * 更新清单 release/latest.json：version / releaseDate / files[{name,url,sha256,size}] /
 *   signing —— url 为占位（发布地址由分发方确定后替换），校验以 sha256 为准。
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release');
const stagingAppDir = path.join(releaseDir, 'staging', 'app');

// 服务端运行面真实依赖（server/ 全量 import 的外部包；--packages=external 保持不打包）
const SERVER_RUNTIME_DEPS = {
  '@google/genai': true,
  'better-sqlite3': true,
  dotenv: true,
  express: true,
  jszip: true,
  multer: true,
};

const args = process.argv.slice(2);
const mode = args.includes('--dir') ? 'dir' : args.includes('--win') ? 'win' : args.includes('--mac') ? 'mac' : null;
if (!mode) {
  console.error('用法: node scripts/release.mjs --dir | --mac | --win');
  process.exit(1);
}

function run(command, cmdArgs, options = {}) {
  console.log(`> ${command} ${cmdArgs.join(' ')}`);
  const result = spawnSync(command, cmdArgs, { stdio: 'inherit', cwd: root, ...options });
  if (result.status !== 0) {
    console.error(`步骤失败（exit ${result.status}）：${command} ${cmdArgs.join(' ')}`);
    process.exit(result.status ?? 1);
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 1) 构建：前端 + 服务端 bundle + Electron 壳 */
function buildAll() {
  run('bun', ['run', 'build']);           // vite build + esbuild dist/server.mjs
  run('bun', ['run', 'build:electron']);  // electron/build/main.cjs + preload
}

/** 2) 精简运行面：dist/ worker/ package.json + 仅服务端依赖的 node_modules */
function stageRuntime() {
  fs.rmSync(path.join(releaseDir, 'staging'), { recursive: true, force: true });
  fs.mkdirSync(stagingAppDir, { recursive: true });

  fs.cpSync(path.join(root, 'dist'), path.join(stagingAppDir, 'dist'), { recursive: true });
  fs.cpSync(path.join(root, 'worker'), path.join(stagingAppDir, 'worker'), { recursive: true, filter: src => !src.includes('__pycache__') && !src.includes('.pytest_cache') });

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const dependencies = {};
  for (const name of Object.keys(SERVER_RUNTIME_DEPS)) {
    const version = pkg.dependencies?.[name];
    if (!version) {
      console.error(`package.json dependencies 缺少服务端运行依赖 ${name}，无法精简打包`);
      process.exit(1);
    }
    dependencies[name] = version;
  }
  const stagedPkg = {
    name: pkg.name,
    version: pkg.version,
    private: true,
    type: 'module',
    comment: 'P0-B #29 精简运行面：仅服务端（dist/server.mjs）真实 import 的外部包',
    dependencies,
  };
  fs.writeFileSync(path.join(stagingAppDir, 'package.json'), `${JSON.stringify(stagedPkg, null, 2)}\n`);
  // staging 无 lockfile（精简依赖清单独立解析），不加 frozen 限制
  run('bun', ['install', '--production'], { cwd: stagingAppDir });
}

/** 3) electron-builder（签名环境变量按平台检测，缺失显式禁用） */
function packageApp() {
  const builderArgs = ['node_modules/electron-builder/out/cli/cli.js', '--config', 'electron-builder.yml'];
  const signing = { mac: 'unsigned', win: 'unsigned' };
  const macCert = process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD;
  const winCert = process.env.WIN_CSC_LINK && process.env.WIN_CSC_KEY_PASSWORD;
  const env = { ...process.env };

  if (mode === 'dir') {
    builderArgs.push('--dir');
  } else if (mode === 'mac') {
    if (macCert) {
      signing.mac = 'cert-env';
    } else {
      console.log('未检测到 CSC_LINK / CSC_KEY_PASSWORD：跳过 mac 签名与公证，产物标注 unsigned');
      env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
      builderArgs.push('-c.mac.identity=null');
    }
    builderArgs.push('--mac');
  } else if (mode === 'win') {
    if (!winCert) console.log('未检测到 WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD：跳过 win 签名，产物标注 unsigned');
    else signing.win = 'cert-env';
    builderArgs.push('--win');
  }
  run('node', builderArgs, { env });
  return signing;
}

/** 4) SHA256SUMS + latest.json 更新清单（--dir 无安装包产物，仅记录结构验证结果） */
function writeManifests(signing) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const installers = fs.readdirSync(releaseDir)
    .filter(name => /\.(dmg|exe|zip|AppImage|snap|deb)$/i.test(name))
    .map(name => {
      const file = path.join(releaseDir, name);
      const stat = fs.statSync(file);
      return { name, size: stat.size, sha256: sha256File(file) };
    });

  if (installers.length > 0) {
    const sums = installers.map(entry => `${entry.sha256}  ${entry.name}`).join('\n');
    fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), `${sums}\n`);
    console.log(`SHA256SUMS.txt：${installers.length} 个产物`);
  }

  const manifest = {
    version: pkg.version,
    releaseDate: new Date().toISOString(),
    files: installers.map(entry => ({
      name: entry.name,
      size: entry.size,
      sha256: entry.sha256,
      url: `https://example.com/semovix-voice/releases/${pkg.version}/${entry.name}`, // 占位：分发地址确定后替换
    })),
    signing,
    notes: 'P0-B #29 首个可安装构建。签名状态见 signing 段（unsigned = 未签名，安装时系统会提示来源不受信）。',
    verification: '请以 SHA256SUMS.txt 中的 sha256 校验下载产物后再安装。',
  };
  fs.writeFileSync(path.join(releaseDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`latest.json：v${pkg.version}（${installers.length} 个产物，signing=${JSON.stringify(signing)}）`);
}

buildAll();
stageRuntime();
const signing = packageApp();
writeManifests(signing);

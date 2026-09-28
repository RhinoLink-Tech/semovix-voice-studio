import fs from 'fs';
import os from 'os';
import path from 'path';

/** /opt、/usr/local 等与用户主目录无关的常见安装根（可注入以便测试隔离本机环境） */
export const DEFAULT_FIXED_CONDA_BASES = [
  '/opt/anaconda3',
  '/opt/miniconda3',
  '/opt/miniforge3',
  '/opt/homebrew/Caskroom/miniforge/base',
  '/usr/local/anaconda3',
  '/usr/local/miniconda3',
];

export interface CondaResolutionOptions {
  /** 用户主目录（默认 os.homedir()） */
  homeDir?: string;
  /** 与主目录无关的安装根；传 [] 可关闭（测试用） */
  fixedBaseDirs?: string[];
}

/**
 * 解析 conda 可执行文件（P0-A #3：GUI 进程不继承交互 shell 的 conda 函数/PATH）
 *
 * conda 在用户 shell 里通常是函数或 ~/anaconda3/bin 不在 GUI 继承的 PATH 上，
 * 直接 spawn 'conda' 会 ENOENT。按优先级解析：
 *   1. CONDA_EXE（conda activate 后由 conda 自身设置）
 *   2. 当前 PATH 上的 conda
 *   3. 常见安装位置（~/anaconda3、~/miniconda3、~/miniforge3、/opt/…）
 *
 * @returns 绝对路径；找不到返回 null（调用方退回裸 'conda'，让 spawn 错误如实暴露）
 */
export function resolveCondaBinary(
  env: NodeJS.ProcessEnv = process.env,
  options: CondaResolutionOptions = {},
): string | null {
  const condaExe = typeof env.CONDA_EXE === 'string' && env.CONDA_EXE.trim() ? env.CONDA_EXE.trim() : null;
  if (condaExe && fs.existsSync(condaExe)) return condaExe;

  if (env.PATH) {
    for (const dir of env.PATH.split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, 'conda');
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // 该目录无 conda，继续
      }
    }
  }

  const home = options.homeDir ?? os.homedir();
  const bases = [
    path.join(home, 'anaconda3'),
    path.join(home, 'miniconda3'),
    path.join(home, 'miniforge3'),
    path.join(home, 'mambaforge'),
    ...(options.fixedBaseDirs ?? DEFAULT_FIXED_CONDA_BASES),
  ];
  for (const base of bases) {
    const candidate = path.join(base, 'bin', 'conda');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

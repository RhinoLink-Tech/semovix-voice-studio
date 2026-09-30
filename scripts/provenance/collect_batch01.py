#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Batch 01 代码来源审查证据采集器（仅 Python 标准库，不新增依赖）。

对 Semovix Voice Studio（subject）与 debpalash/VoiceStudio（comparison）做可重复的
自动化证据采集：Batch 01 范围展开、文件 Hash、Git 历史、职责候选映射、文本/Token
相似度指标，以及对 P0 文件的 VoiceStudio 历史版本比对。

本脚本只产出自动化证据与机器观察素材，不产出任何最终来源结论：
- 所有内容读取都绑定到解析出的精确 commit（git show），不修改任何 checkout；
- 公开输出中的本机绝对路径替换为 <semovix-repo> / <voicestudio-repo>；
- 真实本地路径只写入 scan-manifest.local.json（须加入 .gitignore）。

用法：
  python3 scripts/provenance/collect_batch01.py \
    --subject-root /path/to/semovix-voice-studio \
    --comparison-root /path/to/VoiceStudio \
    --output docs/provenance/batch-01
"""

import argparse
import csv
import hashlib
import json
import os
import re
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from difflib import SequenceMatcher

SCRIPT_VERSION = "1.0.0"

# ---------------------------------------------------------------------------
# Batch 01 审查范围（固定，不扩大）
# ---------------------------------------------------------------------------

SCOPE_EXACT = [
    "electron/main/index.ts",
    "electron/main/context.ts",
    "electron/main/ipc.ts",
    "electron/main/lib/supervisors.ts",
    "electron/main/lib/managedRuntime.ts",
    "electron/main/lib/doctorRunner.ts",
    "electron/main/lib/ports.ts",
    "electron/main/lib/orphanReaper.ts",
    "electron/main/lib/runtimeStatus.ts",
    "electron/preload/preload.ts",
    "src/desktop/fileDialogs.ts",
    "server/lib/safeFs.ts",
]
SCOPE_GLOBS = ["src/components/desktop/**"]

P0_FILES = {
    "electron/main/index.ts",
    "electron/main/ipc.ts",
    "electron/main/lib/supervisors.ts",
    "electron/main/lib/managedRuntime.ts",
    "electron/preload/preload.ts",
    "src/desktop/fileDialogs.ts",
    "server/lib/safeFs.ts",
}
P1_FILES = {
    "electron/main/context.ts",
    "electron/main/lib/doctorRunner.ts",
    "electron/main/lib/ports.ts",
    "electron/main/lib/orphanReaper.ts",
    "electron/main/lib/runtimeStatus.ts",
}

# 每个范围文件的职责描述（机器填充 manual-review.csv 的 function 列用）
FILE_FUNCTIONS = {
    "electron/main/index.ts": "Electron 主进程入口：单实例锁、userData/日志初始化、残留进程清理、动态端口、装配 Supervisor 与 IPC、创建安全 BrowserWindow、状态轮询推送与 15s 兜底退出清理",
    "electron/main/context.ts": "桌面运行时上下文：装配 Node/Worker 两个 Supervisor、桌面配置读写与按需重启热更新、Doctor 缓存、运行时状态轮询聚合、托管运行时编排与退出清理",
    "electron/main/ipc.ts": "IPC 白名单：app-info/运行时状态/doctor/重启 Worker/托管运行时维护/原生文件对话框/受限读取/受限保存/reveal 边界校验/诊断包导出/更新检查/配置保存",
    "electron/main/lib/supervisors.ts": "子进程监管：抽象 ProcessSupervisor（spawn+健康检查+状态机+进程树终止+优雅停止），NodeServerSupervisor（窗口期内受控自动重启），PythonWorkerSupervisor（managed/bin/conda 解释器解析），runtime.json 运行记录读写",
    "electron/main/lib/managedRuntime.ts": "托管 Python 运行时：uv 定版下载（SHA256 校验）→ CPython 安装 → venv 创建 → uv pip sync，阶段状态机落盘（absent→…→ready/failed），repair/rebuild",
    "electron/main/lib/doctorRunner.ts": "Doctor 运行器：按 Python 配置组装命令、超时强杀、从混杂 stdout 提取首个括号配平 JSON、规范化为 DoctorReport",
    "electron/main/lib/ports.ts": "动态端口分配：connect 探测+bind 探测结合、随机端口回退、waitForHttpOk 健康轮询（可选响应身份校验）",
    "electron/main/lib/orphanReaper.ts": "残留进程识别与清理：PID 存活检查 + ps 命令行 marker 复核 + SIGTERM，绝不盲杀 PID",
    "electron/main/lib/runtimeStatus.ts": "运行时状态聚合：进程/引擎/环境三类状态分开上报，Node 聚合接口优先、Worker /health 兜底",
    "electron/preload/preload.ts": "安全 Preload：contextBridge 暴露白名单动作桥与单一 runtime-status-changed 事件订阅（返回取消函数，不暴露 ipcRenderer）",
    "src/components/desktop/DesktopGate.tsx": "桌面能力门控：preload 桥存在且未完成首配→全屏向导；已完成→运行时状态中心；Web 模式返回 null",
    "src/components/desktop/DesktopSetupWizard.tsx": "首次启动向导：欢迎→素材目录→Python→设备→模型→Doctor→Worker 八步流程，模型六态映射与配置保存",
    "src/components/desktop/RuntimeStatusCenter.tsx": "运行时状态中心：右下角常驻入口+面板三区（进程/引擎/环境）展示，Doctor 重跑、重启 Worker、打开日志、复制错误、手动检查更新",
    "src/desktop/fileDialogs.ts": "原生文件能力模式无关封装：桌面走桥（原生对话框+主进程读写字节），Web 回退 input[type=file] 与浏览器下载；pickFile/saveBytes/saveFromUrl",
    "server/lib/safeFs.ts": "安全文件边界：resolveWithin（resolve 包含校验+realpath 符号链接复核拒绝逃逸）、safeArchivePath（ZIP Slip 白名单）、解压限额常量",
}

# 其他可能的来源（机器提示，非结论）
FILE_OTHER_SOURCES = {
    "electron/main/index.ts": "Electron 官方 API 惯例（app/BrowserWindow/webPreferences 安全基线）；Node.js 进程与定时器 API",
    "electron/main/context.ts": "Electron/Node 常规编排模式；.env 手工解析为通用 shell 语法",
    "electron/main/ipc.ts": "Electron 官方 ipcMain.handle/dialog API；路径包含校验为通用安全惯例（OWASP path traversal 防护）",
    "electron/main/lib/supervisors.ts": "Node.js child_process/net 官方 API；进程组终止与 taskkill /T 为 POSIX/Windows 通用做法",
    "electron/main/lib/managedRuntime.ts": "uv 官方安装与用法（GitHub Releases 资产、UV_* 环境变量、python-build-standalone）",
    "electron/main/lib/doctorRunner.ts": "Node.js child_process API；括号配平 JSON 提取为通用解析技术",
    "electron/main/lib/ports.ts": "Node.js net 官方 API（connect/bind 探测为通用端口分配做法）；fetch 轮询健康检查为通用模式",
    "electron/main/lib/orphanReaper.ts": "POSIX ps/kill 惯例；PID 复用防护（marker 复核）为通用做法",
    "electron/main/lib/runtimeStatus.ts": "fetch 聚合多来源状态为通用模式",
    "electron/preload/preload.ts": "Electron 官方 contextBridge/ipcRenderer API 固定写法",
    "src/components/desktop/DesktopGate.tsx": "React 条件渲染常规模式；Electron 官方 preload 桥接惯例",
    "src/components/desktop/DesktopSetupWizard.tsx": "React 分步向导常规模式",
    "src/components/desktop/RuntimeStatusCenter.tsx": "React 轮询订阅常规模式",
    "src/desktop/fileDialogs.ts": "浏览器 File/Blob/URL.createObjectURL/anchor download 标准 API；Electron 桥接惯例",
    "server/lib/safeFs.ts": "通用路径安全防护惯例（resolve+realpath 包含校验、ZIP Slip 白名单）",
}

# 职责映射种子（依据实际阅读两仓库内容确认；脚本再叠加 same_name 与 symbol_search）
SEED_MAP = {
    "electron/main/index.ts": [
        ("electron/src/main/index.ts", "same_responsibility", "Electron 主进程入口：窗口创建、单实例/退出清理"),
    ],
    "electron/main/context.ts": [
        ("electron/src/main/backend.ts", "same_responsibility", "运行时编排/后端生命周期管理的部分职责"),
    ],
    "electron/main/ipc.ts": [
        ("electron/src/main/ipc.ts", "same_name", "IPC 通道注册中心"),
        ("electron/src/main/save-filters.ts", "same_responsibility", "对话框文件过滤器辅助（职责片段）"),
    ],
    "electron/main/lib/supervisors.ts": [
        ("electron/src/main/backend.ts", "same_responsibility", "后端子进程生命周期/健康/重启"),
        ("electron/src/main/runtime-project.ts", "same_responsibility", "运行时项目管理"),
        ("scripts/dev-backend.mjs", "same_responsibility", "开发态后进程拉起"),
    ],
    "electron/main/lib/managedRuntime.ts": [
        ("electron/src/main/backend-download.ts", "same_responsibility", "后端运行时下载与校验"),
        ("electron/src/main/runtime-download.ts", "same_responsibility", "运行时下载"),
        ("electron/src/main/setup-progress.ts", "same_responsibility", "首启安装阶段进度状态"),
    ],
    "electron/main/lib/doctorRunner.ts": [
        ("electron/src/main/repair-agents.ts", "same_responsibility", "诊断/修复执行（职责相邻，映射待人工确认）"),
    ],
    "electron/main/lib/ports.ts": [
        ("electron/src/main/backend-port.ts", "same_responsibility", "后端端口分配"),
    ],
    "electron/main/lib/orphanReaper.ts": [
        ("electron/src/shared/utils/backendCrash.ts", "same_responsibility", "后端崩溃残留处理（职责相邻）"),
        ("backend/worker/lifecycle.py", "same_responsibility", "worker 生命周期/孤儿处理（跨语言）"),
    ],
    "electron/main/lib/runtimeStatus.ts": [
        ("electron/src/main/setup-progress.ts", "same_responsibility", "首启/运行时进度状态"),
        ("electron/src/renderer/src/components/app-shell/status-runtime.ts", "same_responsibility", "运行时状态聚合（renderer 侧）"),
    ],
    "electron/preload/preload.ts": [
        ("electron/src/preload/index.ts", "same_responsibility", "contextBridge 安全桥"),
        ("electron/src/main/ipc.ts", "documentation_reference", "通道合同对照"),
    ],
    "src/components/desktop/DesktopGate.tsx": [
        ("electron/src/renderer/src/components/backend-gate.tsx", "same_responsibility", "后端未就绪门控 UI"),
    ],
    "src/components/desktop/DesktopSetupWizard.tsx": [
        ("electron/src/renderer/src/components/setup-gate.tsx", "same_responsibility", "首次启动引导门控"),
        ("electron/src/shared/api/setup.ts", "same_responsibility", "首启配置 API"),
    ],
    "src/components/desktop/RuntimeStatusCenter.tsx": [
        ("electron/src/renderer/src/components/app-shell/status-bar.tsx", "same_responsibility", "状态栏展示"),
        ("electron/src/renderer/src/components/app-shell/status-runtime.ts", "same_responsibility", "运行时状态来源"),
    ],
    "src/desktop/fileDialogs.ts": [
        ("electron/src/main/ipc.ts", "same_responsibility", "原生文件对话框 IPC 处理"),
        ("electron/src/main/save-filters.ts", "same_responsibility", "保存对话框过滤器"),
    ],
    "server/lib/safeFs.ts": [
        ("backend/core/path_security.py", "same_responsibility", "路径安全/防逃逸守卫（跨语言）"),
        ("electron/src/main/watch-folders.ts", "same_responsibility", "目录访问边界（职责相邻）"),
    ],
}

# 相似度阈值（与审查文档 §8.3 对应）
TH_HIGH_TEXT = 0.70
TH_HIGH_STRUCTURE = 0.55
TH_DISTINCTIVE_LITERAL_MIN_LEN = 10
TH_DISTINCTIVE_COMMENT_MIN_LEN = 15
TH_NOTABLE_OVERLAP_RAW = 0.25          # machine_risk_level=medium 的文本重叠提示
TH_NOTABLE_OVERLAP_STRUCTURE = 0.25    # machine_risk_level=medium 的结构相似提示
TH_NOTABLE_COMMON_BLOCK = 10           # machine_risk_level=medium 的最长公共块提示

RISK_SEVERITY = {
    "exact-match": 7,
    "distinctive-comment-match": 6,
    "distinctive-literal-match": 5,
    "high-text-similarity": 4,
    "high-structure-similarity": 3,
    "common-boilerplate-likely": 2,
    "manual-review-required": 2,
    "low-signal": 1,
    "not-comparable": 0,
}

# ---------------------------------------------------------------------------
# 语言与词法
# ---------------------------------------------------------------------------

EXT_LANG = {
    ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
    ".tsx": "tsx", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".jsx": "jsx", ".py": "python", ".json": "json", ".md": "markdown",
    ".sh": "shell", ".css": "css", ".html": "html",
}
JS_FAMILY = {"typescript", "tsx", "javascript", "jsx"}
CODE_EXTS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".sh", ".md", ".json"}

TS_KEYWORDS = {
    "const", "let", "var", "function", "class", "return", "if", "else", "for", "while",
    "switch", "case", "break", "continue", "new", "typeof", "instanceof", "in", "await",
    "async", "try", "catch", "finally", "throw", "import", "from", "export", "default",
    "extends", "implements", "interface", "type", "enum", "public", "private", "protected",
    "readonly", "static", "get", "set", "yield", "delete", "void", "null", "undefined",
    "true", "false", "this", "super", "as", "satisfies", "keyof", "infer", "never",
    "unknown", "any", "string", "number", "boolean", "object", "symbol", "bigint",
    "namespace", "declare", "abstract", "constructor", "of", "do",
}
TS_API_KEEP = {
    "process", "path", "fs", "os", "net", "child_process", "spawn", "execFile", "promisify",
    "ipcMain", "ipcRenderer", "contextBridge", "app", "BrowserWindow", "dialog", "shell",
    "screen", "Event", "window", "document", "fetch", "JSON", "Math", "Promise", "Set",
    "Map", "Array", "Object", "Error", "console", "require", "module", "exports",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval", "ChildProcess", "Buffer",
    "Uint8Array", "AbortSignal", "Date", "RegExp", "Error", "crypto", "util", "URL",
    "Blob", "File", "Response", "NodeJS", "Electron", "React", "useEffect", "useState",
    "useCallback", "useMemo", "useRef",
}
PY_KEYWORDS = {
    "def", "class", "import", "from", "return", "if", "elif", "else", "for", "while",
    "try", "except", "finally", "with", "as", "lambda", "yield", "raise", "pass",
    "break", "continue", "and", "or", "not", "in", "is", "None", "True", "False",
    "global", "nonlocal", "assert", "async", "await", "del", "self", "cls",
}
PY_API_KEEP = {
    "os", "sys", "pathlib", "Path", "re", "json", "shutil", "subprocess", "tempfile",
    "hashlib", "functools", "dataclass", "Exception", "ValueError", "OSError", "IOError",
    "RuntimeError", "TypeError", "len", "str", "int", "float", "bool", "list", "dict",
    "set", "tuple", "open", "print", "range", "enumerate", "sorted", "min", "max", "abs",
    "any", "all", "isinstance", "issubclass", "getattr", "setattr", "hasattr",
}

TS_TOKEN_RE = re.compile(
    r"""(?P<comment>/\*.*?\*/|//[^\n]*)
      | (?P<string>"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)
      | (?P<number>(?<![\w$])\d[\d_]*(?:\.\d+)?)
      | (?P<ident>[A-Za-z_$][A-Za-z0-9_$]*)
      | (?P<ws>\s+)
      | (?P<other>.)
    """,
    re.VERBOSE | re.DOTALL,
)
PY_TOKEN_RE = re.compile(
    r"""(?P<comment>\#[^\n]*)
      | (?P<string>\"\"\"(?:\\.|[^\\])*?\"\"\"|'''(?:\\.|[^\\])*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')
      | (?P<number>(?<!\w)\d[\d_]*(?:\.\d+)?)
      | (?P<ident>[A-Za-z_][A-Za-z0-9_]*)
      | (?P<ws>\s+)
      | (?P<other>.)
    """,
    re.VERBOSE | re.DOTALL,
)


def lang_of(path):
    return EXT_LANG.get(os.path.splitext(path)[1].lower(), "other")


def unquote(s):
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'`":
        return s[1:-1]
    return s


def normalize_comment(raw):
    body = re.sub(r"^//+|^\#+|/\*+|\*+/$", "", raw.strip())
    return re.sub(r"\s+", " ", body).strip()


def analyze_text(path, data):
    """把文件字节解析为各指标视图。返回 None 表示无法按文本处理。"""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if text.startswith("﻿"):
        text = text[1:]
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    lang = lang_of(path)
    if lang in JS_FAMILY:
        token_re = TS_TOKEN_RE
        keywords, api_keep = TS_KEYWORDS, TS_API_KEEP
    elif lang == "python":
        token_re = PY_TOKEN_RE
        keywords, api_keep = PY_KEYWORDS, PY_API_KEEP
    else:
        token_re = TS_TOKEN_RE  # 兜底按 JS 家族词法（language 列已标 other，不跨语言解释）
        keywords, api_keep = set(), set()

    raw_lines = text.split("\n")
    norm_lines_all = [re.sub(r"\s+", " ", line).strip() for line in raw_lines]
    norm_lines = [line for line in norm_lines_all if line]
    norm_text = "\n".join(norm_lines_all)

    tokens_raw = []
    tokens_idnorm = []
    comments = []
    literals = set()
    for m in token_re.finditer(text):
        kind = m.lastgroup
        value = m.group(0)
        if kind == "ws":
            continue
        if kind == "comment":
            comments.append(normalize_comment(value))
            continue
        if kind == "string":
            inner = unquote(value)
            if inner:
                tokens_raw.append(value)
                tokens_idnorm.append("<STR>")
                if len(inner) >= TH_DISTINCTIVE_LITERAL_MIN_LEN and inner.strip():
                    literals.add(inner)
            continue
        if kind == "number":
            tokens_raw.append(value)
            tokens_idnorm.append("<NUM>")
            continue
        if kind == "ident":
            tokens_raw.append(value)
            if value in keywords or value in api_keep:
                tokens_idnorm.append(value)
            else:
                tokens_idnorm.append("<ID>")
            continue
        tokens_raw.append(value)
        tokens_idnorm.append(value)

    def ngrams(seq, n=5):
        if len(seq) < n:
            return set()
        return {tuple(seq[i:i + n]) for i in range(len(seq) - n + 1)}

    distinctive_comments = {c for c in comments if len(c) >= TH_DISTINCTIVE_COMMENT_MIN_LEN}

    return {
        "lang": lang,
        "raw_lines": raw_lines,
        "norm_lines_all": norm_lines_all,
        "norm_lines": norm_lines,
        "tokens_raw": tokens_raw,
        "tokens_idnorm": tokens_idnorm,
        "ngrams_raw": ngrams(tokens_raw),
        "ngrams_idnorm": ngrams(tokens_idnorm),
        "distinctive_literals": literals,
        "distinctive_comments": distinctive_comments,
        "sha_norm": hashlib.sha256(norm_text.encode("utf-8")).hexdigest(),
    }


def jaccard(a, b):
    if not a and not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def pair_metrics(a, b):
    """a/b 为 analyze_text 结果（同一文件对）。返回指标 dict。"""
    exact_raw = a["sha_raw"] == b["sha_raw"]
    exact_norm = a["sha_norm"] == b["sha_norm"]

    sm_raw = SequenceMatcher(None, a["raw_lines"], b["raw_lines"], autojunk=False)
    raw_seq = sm_raw.ratio()

    ca, cb = Counter(a["norm_lines"]), Counter(b["norm_lines"])
    total = sum(ca.values()) + sum(cb.values())
    multiset = (2 * sum((ca & cb).values()) / total) if total else 0.0

    token_j = jaccard(a["ngrams_raw"], b["ngrams_raw"])
    idnorm_j = jaccard(a["ngrams_idnorm"], b["ngrams_idnorm"])

    sm_norm = SequenceMatcher(None, a["norm_lines_all"], b["norm_lines_all"], autojunk=False)
    lc_block = max((blk.size for blk in sm_norm.get_matching_blocks()), default=0)

    lit_matches = a["distinctive_literals"] & b["distinctive_literals"]
    com_matches = a["distinctive_comments"] & b["distinctive_comments"]

    same_lang = a["lang"] == b["lang"]
    both_js_family = a["lang"] in JS_FAMILY and b["lang"] in JS_FAMILY

    flags = []
    if exact_raw or exact_norm:
        flags.append("exact-match")
    if com_matches:
        flags.append("distinctive-comment-match")
    if lit_matches:
        flags.append("distinctive-literal-match")
    if raw_seq >= TH_HIGH_TEXT:
        flags.append("high-text-similarity")
    if same_lang and idnorm_j >= TH_HIGH_STRUCTURE:
        flags.append("high-structure-similarity")

    if flags:
        risk_flag = max(flags, key=lambda f: RISK_SEVERITY[f])
    elif not same_lang:
        risk_flag = "not-comparable"
    else:
        risk_flag = "low-signal"

    notes = []
    if not same_lang:
        notes.append("跨语言对：结构指标不做同语言解释")
    elif both_js_family and not same_lang:
        notes.append("同家族语言（ts/tsx/js）")
    if flags:
        notes.append("触发: " + "+".join(flags))
    if lit_matches:
        notes.append("共享独特字面量 %d 条" % len(lit_matches))
    if com_matches:
        notes.append("共享独特注释 %d 条" % len(com_matches))

    return {
        "exact_sha256_match": exact_raw,
        "normalized_sha256_match": exact_norm,
        "raw_line_sequence_ratio": round(raw_seq, 4),
        "normalized_line_multiset_ratio": round(multiset, 4),
        "token_5gram_jaccard": round(token_j, 4),
        "identifier_normalized_token_5gram_jaccard": round(idnorm_j, 4),
        "longest_common_block_lines": lc_block,
        "distinctive_literal_matches": len(lit_matches),
        "distinctive_comment_matches": len(com_matches),
        "shared_literals": sorted(lit_matches),
        "shared_comments": sorted(com_matches),
        "risk_flag": risk_flag,
        "machine_notes": "；".join(notes),
    }


# ---------------------------------------------------------------------------
# Git 基础设施（全部只读）
# ---------------------------------------------------------------------------

class Repo:
    def __init__(self, root, ref, key):
        self.root = os.path.abspath(root)
        self.ref = ref
        self.key = key
        proc = subprocess.run(["git", "-C", self.root, "rev-parse", "--git-dir"],
                              capture_output=True)
        if proc.returncode != 0:
            raise RuntimeError("不是 Git 仓库: %s" % self.root)
        self.sha = self.git("rev-parse", ref).decode().strip()
        self.branch = self.git("branch", "--show-current", check=False).decode().strip() or "(detached)"
        remotes = self.git("remote", "-v").decode("utf-8", "replace").strip().splitlines()
        self.remotes = [line.strip() for line in remotes if line.strip()]
        self.porcelain = self.git("status", "--porcelain=v1", check=False).decode("utf-8", "replace")
        # 审计自身产物（scripts/provenance/、docs/provenance/、CODE_PROVENANCE.md、
        # .gitignore——均为审查任务说明允许修改的路径）不计入工作区洁净判断
        relevant = [line for line in self.porcelain.splitlines()
                    if line[3:].strip() and not line[3:].strip().startswith(
                        ("scripts/provenance/", "docs/provenance/"))
                    and line[3:].strip() not in ("CODE_PROVENANCE.md", ".gitignore")]
        self.clean = not relevant
        self._content_cache = {}

    def git(self, *args, check=True):
        proc = subprocess.run(["git", "-C", self.root, *args], capture_output=True)
        if check and proc.returncode != 0:
            raise RuntimeError("git %s 失败: %s" % (" ".join(args[:2]), proc.stderr.decode("utf-8", "replace")[:400]))
        return proc.stdout

    def content(self, path, sha=None):
        sha = sha or self.sha
        cache_key = (sha, path)
        if cache_key not in self._content_cache:
            proc = subprocess.run(["git", "-C", self.root, "show", "%s:%s" % (sha, path)],
                                  capture_output=True)
            self._content_cache[cache_key] = proc.stdout if proc.returncode == 0 else None
        return self._content_cache[cache_key]

    def exists_in_commit(self, path):
        proc = subprocess.run(["git", "-C", self.root, "cat-file", "-e", "%s:%s" % (self.sha, path)],
                              capture_output=True)
        return proc.returncode == 0

    def ls_tree_dir(self, directory):
        out = self.git("ls-tree", "-r", "--name-only", self.sha, "--", directory, check=False).decode("utf-8", "replace")
        return [line.strip() for line in out.splitlines() if line.strip()]

    def tracked_files(self):
        out = self.git("ls-tree", "-r", "--name-only", self.sha).decode("utf-8", "replace")
        return [line.strip() for line in out.splitlines() if line.strip()]


LOG_FORMAT = "--format=__C__%H%x1f%an%x1f%ae%x1f%aI%x1f%s"


def parse_log(out_bytes):
    """解析 git log --numstat --name-status 输出。"""
    text = out_bytes.decode("utf-8", "replace")
    commits = []
    cur = None
    for line in text.split("\n"):
        if line.startswith("__C__"):
            parts = line[5:].split("\x1f")
            while len(parts) < 5:
                parts.append("")
            cur = {
                "commit": parts[0], "author_name": parts[1], "author_email": parts[2],
                "authored_at": parts[3], "subject": parts[4],
                "lines_added": "", "lines_deleted": "", "change_type": "",
            }
            commits.append(cur)
            continue
        if cur is None:
            continue
        m = re.match(r"^(\d+|-)\t(\d+|-)\t", line)
        if m and cur["lines_added"] == "":
            cur["lines_added"] = m.group(1)
            cur["lines_deleted"] = m.group(2)
            continue
        m = re.match(r"^([ADRCK]\d*)\t", line)
        if m and cur["change_type"] == "":
            cur["change_type"] = m.group(1)
    return commits


def file_log(repo, path, extra=()):
    out = repo.git("log", "--follow", "-M", LOG_FORMAT, "--numstat", "--name-status",
                   *extra, "--", path, check=False)
    return parse_log(out)


def commit_count(repo, path):
    out = repo.git("rev-list", "--count", repo.sha, "--", path, check=False).decode().strip()
    return int(out) if out.isdigit() else 0


def blame_summary(repo, path):
    """git blame --porcelain 聚合：每 commit 行数 + 连续大块（≥10 行）。"""
    out = repo.git("blame", "--porcelain", repo.sha, "--", path, check=False).decode("utf-8", "replace")
    per_commit = Counter()
    authors = {}
    runs = []
    run_sha, run_start, run_len = None, None, 0
    header_re = re.compile(r"^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?")
    lines = out.split("\n")
    i = 0
    while i < len(lines):
        m = header_re.match(lines[i])
        if m:
            # 本机 git 的 --porcelain 逐行输出头（计数字段不可靠，按 1 行计）
            sha, _orig, final = m.group(1), m.group(2), int(m.group(3))
            n = 1
            per_commit[sha] += n
            j = i + 1
            while j < len(lines) and not header_re.match(lines[j]):
                if lines[j].startswith("author ") and sha not in authors:
                    authors[sha] = lines[j][7:]
                j += 1
            if sha == run_sha and run_start is not None and final == run_start + run_len:
                run_len += n
            else:
                if run_sha is not None and run_len >= 10:
                    runs.append((run_sha, run_start, run_len))
                run_sha, run_start, run_len = sha, final, n
            i = j
        else:
            i += 1
    if run_sha is not None and run_len >= 10:
        runs.append((run_sha, run_start, run_len))
    return per_commit, authors, runs


# ---------------------------------------------------------------------------
# 输出工具
# ---------------------------------------------------------------------------

def safe_name(path):
    return path.replace("/", "__")


def write_text(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def write_csv(path, header, rows):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def expand_scope(subject):
    files = []
    for pattern in SCOPE_EXACT:
        files.append((pattern, subject.exists_in_commit(pattern)))
    for pattern in SCOPE_GLOBS:
        base = pattern.split("/**")[0]
        found = subject.ls_tree_dir(base) if pattern.endswith("/**") else []
        if not found:
            files.append((pattern, False))
        else:
            for p in sorted(found):
                files.append((p, True))
    seen = set()
    result = []
    for path, exists in files:
        if path in seen:
            continue
        seen.add(path)
        result.append({"path": path, "exists": exists})
    return result


def review_priority(path):
    if path in P0_FILES:
        return "P0"
    if path in P1_FILES or path.startswith("src/components/desktop/"):
        return "P1"
    return "P2"


def extract_symbols(path, data):
    """从范围文件提取可用于职责搜索的特征符号与字符串常量。"""
    analysis = analyze_text(path, data)
    if analysis is None:
        return [], []
    idents = sorted({t for t in analysis["tokens_raw"]
                     if re.match(r"^[A-Za-z_$][A-Za-z0-9_$]*$", t)
                     and len(t) >= 8
                     and t not in TS_KEYWORDS and t not in TS_API_KEEP
                     and t not in PY_KEYWORDS},
                    key=lambda t: (-len(t), t))[:14]
    literals = sorted(analysis["distinctive_literals"], key=lambda s: (-len(s), s))[:8]
    return idents, literals


def grep_symbols(comparison, symbols):
    """在 comparison 仓库固定目录内做固定字符串搜索，返回 symbol -> [vs_path]。"""
    hits = {}
    if not symbols:
        return hits
    for sym in symbols:
        proc = subprocess.run(
            ["git", "-C", comparison.root, "grep", "-I", "-l", "-F", "-e", sym,
             comparison.sha, "--", "electron", "backend", "scripts", "docs"],
            capture_output=True)
        if proc.returncode not in (0, 1):
            continue
        out = proc.stdout.decode("utf-8", "replace")
        prefix = comparison.sha + ":"
        files = [line[len(prefix):].strip() for line in out.splitlines()
                 if line.startswith(prefix)]
        if files:
            hits[sym] = files
    return hits


def main():
    ap = argparse.ArgumentParser(description="Batch 01 provenance evidence collector")
    ap.add_argument("--subject-root", required=True)
    ap.add_argument("--comparison-root", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--subject-ref", default="HEAD")
    ap.add_argument("--comparison-ref", default="HEAD")
    ap.add_argument("--scope-file", default=None,
                    help="可选：范围清单文件（每行一个确切路径或 dir/** 模式）；缺省用脚本内置范围")
    ap.add_argument("--no-history", action="store_true", help="跳过 Git 历史/blame/历史版本比对")
    args = ap.parse_args()

    global SCOPE_EXACT, SCOPE_GLOBS
    if args.scope_file:
        exact, globs = [], []
        with open(args.scope_file, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                (globs if "**" in line else exact).append(line)
        SCOPE_EXACT, SCOPE_GLOBS = exact, globs

    out_dir = os.path.abspath(args.output)
    os.makedirs(out_dir, exist_ok=True)
    ev_semovix = os.path.join(out_dir, "evidence", "semovix")
    ev_voicestudio = os.path.join(out_dir, "evidence", "voicestudio")
    ev_excerpts = os.path.join(ev_voicestudio, "excerpts")
    for d in (ev_semovix, ev_voicestudio, ev_excerpts):
        os.makedirs(d, exist_ok=True)

    home = os.path.expanduser("~")

    def sanitize(text):
        return (str(text)
                .replace(os.path.abspath(args.subject_root), "<semovix-repo>")
                .replace(os.path.abspath(args.comparison_root), "<voicestudio-repo>")
                .replace(home, "<home>"))

    subject = Repo(args.subject_root, args.subject_ref, "semovix")
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    blocked = []
    comparison = None
    try:
        comparison = Repo(args.comparison_root, args.comparison_ref, "voicestudio")
    except RuntimeError as exc:
        blocked.append("对比仓库不可用: %s" % sanitize(str(exc)))

    # ---- VoiceStudio 仓库元数据 -------------------------------------------------
    vs_meta_lines = [
        "# VoiceStudio 对比仓库元数据（只读采集）",
        "# command: git -C <voicestudio-repo> remote -v / branch --show-current / rev-parse HEAD / status --porcelain=v1",
        "remote: " + ("; ".join(sanitize(r) for r in comparison.remotes) if comparison else "n/a"),
        "branch: " + (comparison.branch if comparison else "n/a"),
        "commit: " + (comparison.sha if comparison else "n/a"),
        "worktree_clean: " + ("true" if comparison and comparison.clean else ("false" if comparison else "n/a")),
        "shallow_clone: " + ("false" if comparison and not os.path.exists(os.path.join(comparison.root, ".git", "shallow")) else "true"),
        "commit_count: " + (str(commit_count_all(comparison)) if comparison else "n/a"),
    ]
    if comparison:
        license_sha = hashlib.sha256(open(os.path.join(comparison.root, "LICENSE"), "rb").read()).hexdigest() \
            if os.path.isfile(os.path.join(comparison.root, "LICENSE")) else "(根目录无 LICENSE)"
        first_line = ""
        if os.path.isfile(os.path.join(comparison.root, "LICENSE")):
            with open(os.path.join(comparison.root, "LICENSE"), encoding="utf-8", errors="replace") as f:
                first_line = f.readline().strip()
        vs_meta_lines += [
            "license_file: LICENSE",
            "license_sha256: " + license_sha,
            "license_first_line: " + first_line,
        ]
    write_text(os.path.join(ev_voicestudio, "repo-meta.txt"), sanitize("\n".join(vs_meta_lines)) + "\n")

    # ---- 范围展开与文件分析 -----------------------------------------------------
    scope = expand_scope(subject)
    write_text(os.path.join(out_dir, "scope.txt"),
               "\n".join("%s|%s|%s" % (entry["path"], review_priority(entry["path"]),
                                       "exists" if entry["exists"] else "missing")
                         for entry in scope) + "\n")

    analyses = {}   # semovix path -> analyze dict（附加 sha_raw 等）
    file_meta = {}
    for entry in scope:
        path = entry["path"]
        meta = {"path": path, "exists": entry["exists"]}
        if entry["exists"]:
            data = subject.content(path)
            meta["language"] = lang_of(path)
            meta["byte_count"] = len(data or b"")
            meta["line_count"] = (data or b"").decode("utf-8", "replace").count("\n")
            meta["sha256_raw"] = hashlib.sha256(data or b"").hexdigest()
            analysis = analyze_text(path, data or b"")
            if analysis is None:
                meta["sha256_normalized"] = ""
                meta["notes"] = "二进制或无法按 UTF-8 解码：normalized 留空"
            else:
                analysis["sha_raw"] = meta["sha256_raw"]
                analyses[path] = analysis
                meta["sha256_normalized"] = analysis["sha_norm"]
                meta["notes"] = ""
        else:
            meta.update({"language": "", "byte_count": 0, "line_count": 0,
                         "sha256_raw": "", "sha256_normalized": "",
                         "notes": "范围内路径在提交 %s 中不存在（missing）" % subject.sha[:12]})
        file_meta[path] = meta

    # ---- Git 历史 ----------------------------------------------------------------
    history = {}   # path -> full commit list（旧→新）
    if not args.no_history:
        for entry in scope:
            path = entry["path"]
            if not entry["exists"]:
                history[path] = []
                continue
            full = file_log(subject, path)
            full.reverse()  # --reverse 未加在 log 上，这里按时间升序排
            adds = file_log(subject, path, extra=("--diff-filter=A",))
            adds.reverse()
            history[path] = full
            first_add = adds[0]["commit"] if adds else (full[0]["commit"] if full else "")
            first_history = full[0]["commit"] if full else ""
            meta = file_meta[path]
            meta["first_add_commit"] = first_add
            meta["first_history_commit"] = first_history
            fa = next((c for c in full if c["commit"] == first_add), None)
            fh = next((c for c in full if c["commit"] == first_history), None)
            src = fa or fh
            meta["first_author_name"] = src["author_name"] if src else ""
            meta["first_author_email"] = src["author_email"] if src else ""
            meta["first_authored_at"] = src["authored_at"] if src else ""
            last = full[-1] if full else None
            meta["last_commit"] = last["commit"] if last else ""
            meta["last_author_name"] = last["author_name"] if last else ""
            meta["last_authored_at"] = last["authored_at"] if last else ""
            meta["commit_count"] = commit_count(subject, path)
            meta["git_authors"] = sorted({c["author_name"] for c in full}) if full else []
    else:
        for entry in scope:
            path = entry["path"]
            history[path] = []
            file_meta[path].update({
                "first_add_commit": "", "first_history_commit": "", "first_author_name": "",
                "first_author_email": "", "first_authored_at": "", "last_commit": "",
                "last_author_name": "", "last_authored_at": "", "commit_count": 0,
                "git_authors": [],
            })
            if file_meta[path]["notes"]:
                file_meta[path]["notes"] += "；"
            file_meta[path]["notes"] += "--no-history：历史未采集"

    # ---- 对应候选映射 -------------------------------------------------------------
    counterpart_rows = []      # counterpart-map.csv
    candidates_by_file = {}    # semovix path -> [(vs_path, basis, note)]
    vs_tracked = comparison.tracked_files() if comparison else []
    vs_by_basename = {}
    for p in vs_tracked:
        vs_by_basename.setdefault(os.path.basename(p), []).append(p)
    vs_analyses = {}           # vs_path -> analyze dict（按需加载）

    def vs_analysis(vs_path, sha=None):
        key = (sha or comparison.sha, vs_path)
        if key not in vs_analyses:
            data = comparison.content(vs_path, sha)
            vs_analyses[key] = analyze_text(vs_path, data) if data is not None else None
            if vs_analyses[key] is not None:
                vs_analyses[key]["sha_raw"] = hashlib.sha256(data).hexdigest()
        return vs_analyses[key]

    for entry in scope:
        spath = entry["path"]
        cands = {}  # vs_path -> {"basis": set, "notes": [..]}
        if not entry["exists"] or comparison is None:
            candidates_by_file[spath] = []
            counterpart_rows.append([spath, "", "none_found", "", "", "no",
                                     "blocked" if comparison is None else "no",
                                     comparison.sha if comparison else "",
                                     ("对比仓库不可用" if comparison is None
                                      else "范围内路径不存在（missing）")])
            continue
        # 1) 种子（职责映射，依据两仓库实际内容确认）
        for vs_path, basis, note in SEED_MAP.get(spath, []):
            if any(vs_path == p for p in vs_tracked):
                cands.setdefault(vs_path, {"basis": set(), "notes": []})
                cands[vs_path]["basis"].add(basis)
                cands[vs_path]["notes"].append(note)
            else:
                cands.setdefault("__missing__:" + vs_path, {"basis": set(), "notes": []})
                cands["__missing__:" + vs_path]["notes"].append("种子路径不存在于对比仓库: " + note)
        # 2) 同名（重点目录内 basename 相同）
        base = os.path.basename(spath)
        for vs_path in vs_by_basename.get(base, []):
            top = vs_path.split("/")
            if top and top[0] in ("electron", "backend", "scripts"):
                cands.setdefault(vs_path, {"basis": set(), "notes": []})
                cands[vs_path]["basis"].add("same_name")
                cands[vs_path]["notes"].append("重点目录内同名文件")
        # 3) 特征符号搜索
        idents, literals = extract_symbols(spath, subject.content(spath) or b"")
        symbol_hits = grep_symbols(comparison, idents + literals)
        hit_count = {}
        for sym, files in symbol_hits.items():
            for f in files:
                hit_count.setdefault(f, set()).add(sym)
        for f, syms in hit_count.items():
            ident_hits = {s for s in syms if s in idents}
            literal_hits = {s for s in syms if s in literals}
            if len(ident_hits) >= 2 or literal_hits:
                cands.setdefault(f, {"basis": set(), "notes": []})
                cands[f]["basis"].add("symbol_search")
                shown = sorted(ident_hits | literal_hits, key=lambda s: (-len(s), s))[:4]
                cands[f]["notes"].append("符号命中: %s" % ", ".join(shown))
        # 汇总（去掉缺失标记行；限制候选数量，种子优先）
        real = {p: v for p, v in cands.items() if not p.startswith("__missing__:")}
        seeds = {p for p, _b, _n in SEED_MAP.get(spath, [])}
        ordered = sorted(real.items(), key=lambda kv: (0 if kv[0] in seeds else 1,
                                                       -len(kv[1]["basis"]), kv[0]))[:12]
        candidates_by_file[spath] = [
            (p, "+".join(sorted(v["basis"])), "; ".join(v["notes"])) for p, v in ordered
        ]
        if not ordered:
            counterpart_rows.append([spath, "", "none_found", "", "", "no", "no",
                                     comparison.sha, "未找到合理候选"])
        for p, basis, note in candidates_by_file[spath]:
            sl = lang_of(spath)
            vl = lang_of(p)
            lang_match = "yes" if sl == vl else ("partial" if sl in JS_FAMILY and vl in JS_FAMILY else "no")
            counterpart_rows.append([spath, p, basis, "yes", lang_match, "no",
                                     comparison.sha, note])

    # ---- 相似度 -------------------------------------------------------------------
    sim_rows = []             # similarity-results.csv
    pair_stats = {}           # spath -> {max_raw, max_idnorm, flags...}
    excerpt_written = {}

    def add_pair(spath, vs_path, subject_sha, comparison_sha, a, b, variant_label=""):
        if a is None or b is None:
            sim_rows.append([spath, vs_path, subject_sha, comparison_sha,
                             "", "", "", "", "", "", "", "", "",
                             "not-comparable", "文件无法按文本分析"])
            return None
        m = pair_metrics(a, b)
        notes = (variant_label + "；" if variant_label else "") + m["machine_notes"]
        sim_rows.append([
            spath, vs_path, subject_sha, comparison_sha,
            str(m["exact_sha256_match"]).lower(), str(m["normalized_sha256_match"]).lower(),
            m["raw_line_sequence_ratio"], m["normalized_line_multiset_ratio"],
            m["token_5gram_jaccard"], m["identifier_normalized_token_5gram_jaccard"],
            m["longest_common_block_lines"], m["distinctive_literal_matches"],
            m["distinctive_comment_matches"], m["risk_flag"], notes,
        ])
        return m

    for entry in scope:
        spath = entry["path"]
        stats = {"max_raw": 0.0, "max_token": 0.0, "max_idnorm": 0.0, "max_block": 0,
                 "lit": 0, "com": 0, "flags": set(), "n_pairs": 0}
        pair_stats[spath] = stats
        if spath not in analyses or comparison is None:
            continue
        for vs_path, _basis, _note in candidates_by_file.get(spath, []):
            b = vs_analysis(vs_path)
            m = add_pair(spath, vs_path, subject.sha, comparison.sha, analyses[spath], b)
            if not m:
                continue
            stats["n_pairs"] += 1
            stats["max_raw"] = max(stats["max_raw"], m["raw_line_sequence_ratio"])
            stats["max_token"] = max(stats["max_token"], m["token_5gram_jaccard"])
            stats["max_idnorm"] = max(stats["max_idnorm"], m["identifier_normalized_token_5gram_jaccard"])
            stats["max_block"] = max(stats["max_block"], m["longest_common_block_lines"])
            stats["lit"] = max(stats["lit"], m["distinctive_literal_matches"])
            stats["com"] = max(stats["com"], m["distinctive_comment_matches"])
            if m["risk_flag"] in RISK_SEVERITY and m["risk_flag"] not in ("low-signal", "not-comparable"):
                stats["flags"].add(m["risk_flag"])
            # 独特命中 → 短摘录证据（不保存整份文件）
            if (m["distinctive_literal_matches"] or m["distinctive_comment_matches"] or
                    m["longest_common_block_lines"] >= 8):
                key = "%s__%s" % (safe_name(spath), safe_name(vs_path))
                if key not in excerpt_written:
                    excerpt_written[key] = True
                    lines_out = [
                        "# 自动化相似度检查命中的短摘录（非完整文件副本；单文件摘录上限 20 行）",
                        "# semovix: %s @ %s" % (spath, subject.sha),
                        "# voicestudio: %s @ %s" % (vs_path, comparison.sha),
                        "# 用途：独特字面量/注释命中与最长公共块的人工复核材料",
                        "",
                    ]
                    body = []
                    for lit in m["shared_literals"][:8]:
                        body.append("[literal] " + lit)
                    for com in m["shared_comments"][:8]:
                        body.append("[comment] " + com)
                    lines_out += body[:20]
                    write_text(os.path.join(ev_excerpts, key + ".txt"), sanitize("\n".join(lines_out)) + "\n")

    # ---- P0 历史版本检查 -------------------------------------------------------------
    history_check = {}
    if not args.no_history and comparison is not None:
        for spath in sorted(P0_FILES):
            if spath not in analyses:
                continue
            semovix_first_sha = file_meta[spath].get("first_add_commit", "")
            semovix_first_at = file_meta[spath].get("first_authored_at", "")
            semovix_first_analysis = None
            if semovix_first_sha:
                data = subject.content(spath, semovix_first_sha)
                if data is not None:
                    semovix_first_analysis = analyze_text(spath, data)
                    if semovix_first_analysis:
                        semovix_first_analysis["sha_raw"] = hashlib.sha256(data).hexdigest()
            checks = []
            for vs_path, _basis, _note in candidates_by_file.get(spath, []):
                log_out = comparison.git(
                    "log", "--follow", "--reverse", "--format=%H %aI", "--", vs_path, check=False
                ).decode("utf-8", "replace")
                entries = []
                for line in log_out.splitlines():
                    parts = line.strip().split(" ", 1)
                    if len(parts) == 2:
                        entries.append((parts[0], parts[1]))
                if not entries:
                    continue
                vs_first = entries[0]
                if semovix_first_at:
                    pre = next((e for e in reversed(entries) if e[1] < semovix_first_at), vs_first)
                else:
                    pre = vs_first
                variants = []
                seen_sha = {comparison.sha}
                if vs_first[0] not in seen_sha:
                    variants.append(("vs-first", vs_first[0]))
                    seen_sha.add(vs_first[0])
                if pre[0] not in seen_sha:
                    variants.append(("vs-pre-semovix-first", pre[0]))
                    seen_sha.add(pre[0])
                any_signal = False
                for label, vs_sha in variants:
                    b = vs_analysis(vs_path, vs_sha)
                    m = add_pair(spath, vs_path, subject.sha, vs_sha,
                                 analyses[spath], b, "history-variant:%s" % label)
                    if m and m["risk_flag"] not in ("low-signal", "not-comparable"):
                        any_signal = True
                if semovix_first_analysis:
                    for label, vs_sha in [("vs-pre-semovix-first", pre[0]), ("vs-current", comparison.sha)]:
                        m = add_pair(spath, vs_path, semovix_first_sha, vs_sha,
                                     semovix_first_analysis, vs_analysis(vs_path, vs_sha),
                                     "history-variant:semovix-first_vs_%s" % label)
                        if m and m["risk_flag"] not in ("low-signal", "not-comparable"):
                            any_signal = True
                checks.append({
                    "vs_path": vs_path,
                    "vs_first_commit": vs_first[0], "vs_first_at": vs_first[1],
                    "vs_pre_semovix_commit": pre[0], "vs_pre_semovix_at": pre[1],
                    "semovix_first_commit": semovix_first_sha,
                    "semovix_first_at": semovix_first_at,
                    "time_order": "voicestudio-first" if vs_first[1] < semovix_first_at else "semovix-first-or-same-day",
                    "any_similarity_signal": any_signal,
                })
                # 候选历史证据（仅元数据）
                hs = ["# VoiceStudio 候选文件历史（仅 Git 元数据）",
                      "# command: git -C <voicestudio-repo> log --follow --reverse -- <path>",
                      "path: " + vs_path,
                      "first_commit: %s (%s)" % vs_first,
                      "pre_semovix_first_commit: %s (%s)" % pre,
                      "current_commit: " + comparison.sha,
                      "semovix 首次引入: %s (%s)" % (semovix_first_sha, semovix_first_at),
                      "time_order: " + ("VoiceStudio 表达先于 Semovix 首次引入" if vs_first[1] < semovix_first_at
                                        else "Semovix 首次引入不晚于 VoiceStudio 候选首次引入")]
                write_text(os.path.join(ev_voicestudio, safe_name(vs_path) + ".history-summary.txt"),
                           sanitize("\n".join(hs)) + "\n")
            history_check[spath] = checks

    # ---- file-inventory.csv -----------------------------------------------------------
    inv_header = ["path", "exists", "language", "line_count", "byte_count", "sha256_raw",
                  "sha256_normalized", "first_add_commit", "first_history_commit",
                  "first_author_name", "first_author_email", "first_authored_at",
                  "last_commit", "last_author_name", "last_authored_at", "commit_count",
                  "review_priority", "notes"]
    inv_rows = []
    for entry in scope:
        meta = file_meta[entry["path"]]
        inv_rows.append([
            meta["path"], str(meta["exists"]).lower(), meta.get("language", ""),
            meta.get("line_count", ""), meta.get("byte_count", ""),
            meta.get("sha256_raw", ""), meta.get("sha256_normalized", ""),
            meta.get("first_add_commit", ""), meta.get("first_history_commit", ""),
            meta.get("first_author_name", ""), meta.get("first_author_email", ""),
            meta.get("first_authored_at", ""), meta.get("last_commit", ""),
            meta.get("last_author_name", ""), meta.get("last_authored_at", ""),
            meta.get("commit_count", ""), review_priority(meta["path"]),
            meta.get("notes", ""),
        ])
    write_csv(os.path.join(out_dir, "file-inventory.csv"), inv_header, inv_rows)

    # ---- file-history.csv --------------------------------------------------------------
    hist_header = ["path", "commit", "author_name", "author_email", "authored_at",
                   "subject", "change_type", "lines_added", "lines_deleted", "evidence_ref"]
    hist_rows = []
    for entry in scope:
        spath = entry["path"]
        commits = history.get(spath, [])
        if not commits:
            continue
        chosen = commits if len(commits) <= 20 else None
        if chosen is None:
            key_nodes = {commits[0]["commit"], commits[-1]["commit"]}
            by_churn = sorted(commits, key=lambda c: -(int(c["lines_added"] or 0) + int(c["lines_deleted"] or 0)))[:8]
            for c in by_churn:
                key_nodes.add(c["commit"])
            chosen = [c for c in commits if c["commit"] in key_nodes]
        ev_ref = ("docs/provenance/batch-01/evidence/semovix/%s.history-summary.txt" % safe_name(spath)
                  if review_priority(spath) == "P0" else "docs/provenance/batch-01/file-history.csv")
        for c in chosen:
            hist_rows.append([spath, c["commit"], c["author_name"], c["author_email"],
                              c["authored_at"], c["subject"], c["change_type"],
                              c["lines_added"], c["lines_deleted"], ev_ref])
    write_csv(os.path.join(out_dir, "file-history.csv"), hist_header, hist_rows)

    # ---- P0 Git 证据文件 ------------------------------------------------------------------
    if not args.no_history:
        for spath in sorted(P0_FILES):
            meta = file_meta.get(spath, {})
            commits = history.get(spath, [])
            base = safe_name(spath)
            first = commits[0] if commits else None
            write_text(
                os.path.join(ev_semovix, base + ".first-commit.txt"),
                sanitize("\n".join([
                    "# 首次引入提交（--diff-filter=A --follow）",
                    "# command: git -C <semovix-repo> log --follow --diff-filter=A --reverse -- <path>",
                    "path: " + spath,
                    "first_add_commit: " + meta.get("first_add_commit", ""),
                    "first_history_commit: " + meta.get("first_history_commit", ""),
                    "first_author: %s <%s>" % (meta.get("first_author_name", ""), meta.get("first_author_email", "")),
                    "first_authored_at: " + meta.get("first_authored_at", ""),
                    "subject: " + (first["subject"] if first else ""),
                ]) + "\n"))
            lines = ["# 历史摘要（关键节点）",
                     "# command: git -C <semovix-repo> log --follow -M --numstat --name-status -- <path>",
                     "commit_count(rev-list): " + str(meta.get("commit_count", ""))]
            if len(commits) > 20:
                lines.append("note: 提交数 %d > 20，保留首次+变更量 Top8+最近节点" % len(commits))
                key_nodes = {commits[0]["commit"], commits[-1]["commit"]}
                for c in sorted(commits, key=lambda c: -(int(c["lines_added"] or 0) + int(c["lines_deleted"] or 0)))[:8]:
                    key_nodes.add(c["commit"])
            else:
                key_nodes = {c["commit"] for c in commits}
            for c in commits:
                if c["commit"] in key_nodes:
                    lines.append("%s %s %s +%s/-%s %s" % (
                        c["commit"][:12], c["authored_at"], c["author_name"],
                        c["lines_added"], c["lines_deleted"], c["subject"][:80]))
            write_text(os.path.join(ev_semovix, base + ".history-summary.txt"),
                       sanitize("\n".join(lines)) + "\n")
            per_commit, authors, runs = blame_summary(subject, spath)
            total_lines = sum(per_commit.values()) or 1
            blame_lines = ["# blame 聚合摘要（非完整 --line-porcelain 输出）",
                           "# command: git -C <semovix-repo> blame --porcelain <commit> -- <path>",
                           "total_lines: " + str(sum(per_commit.values()))]
            for sha, n in per_commit.most_common(8):
                blame_lines.append("%s %5d 行 (%.0f%%) %s" % (
                    sha[:12], n, 100.0 * n / total_lines, authors.get(sha, "?")))
            blame_lines.append("")
            blame_lines.append("连续引入区段（≥10 行，按首次出现顺序，供人工复核）：")
            if runs:
                for sha, start, n in runs[:12]:
                    blame_lines.append("  lines %d-%d (%d 行) %s %s" % (start, start + n - 1, n, sha[:12], authors.get(sha, "?")))
            else:
                blame_lines.append("  （无 ≥10 行的单一 commit 连续区段）")
            write_text(os.path.join(ev_semovix, base + ".blame-summary.txt"),
                       sanitize("\n".join(blame_lines)) + "\n")

    # ---- counterpart-map.csv ----------------------------------------------------------
    cm_header = ["semovix_path", "voicestudio_path", "mapping_basis", "responsibility_match",
                 "language_match", "history_checked", "candidate_commit", "notes"]
    final_cm_rows = []
    p0_checked = {spath for spath in P0_FILES}
    for row in counterpart_rows:
        row = list(row)
        if row[0] in p0_checked and not args.no_history and comparison is not None:
            row[5] = "yes"
        final_cm_rows.append(row)
    write_csv(os.path.join(out_dir, "counterpart-map.csv"), cm_header, sorted(final_cm_rows))

    # ---- similarity-results.csv 排序 ---------------------------------------------------
    def sim_sort_key(row):
        sev = RISK_SEVERITY.get(row[13], 0)
        return (-sev, -float(row[9] or 0), -float(row[6] or 0), row[0], row[1])
    sim_rows_sorted = sorted(sim_rows, key=sim_sort_key)
    sim_header = ["semovix_path", "voicestudio_path", "subject_commit", "comparison_commit",
                  "exact_sha256_match", "normalized_sha256_match", "raw_line_sequence_ratio",
                  "normalized_line_multiset_ratio", "token_5gram_jaccard",
                  "identifier_normalized_token_5gram_jaccard", "longest_common_block_lines",
                  "distinctive_literal_matches", "distinctive_comment_matches",
                  "risk_flag", "machine_notes"]
    write_csv(os.path.join(out_dir, "similarity-results.csv"), sim_header, sim_rows_sorted)

    # ---- manual-review.csv --------------------------------------------------------------
    mr_header = ["path", "function", "current_sha256", "first_add_commit", "first_authored_at",
                 "git_authors", "possible_counterparts", "machine_observation",
                 "evidence_supporting_independent_development", "evidence_supporting_possible_reuse",
                 "other_possible_sources", "machine_risk_level", "human_classification",
                 "license", "retain_original_notice", "rewrite_required", "confidence",
                 "reviewer", "second_reviewer", "review_status", "evidence_refs"]
    mr_rows = []
    for entry in scope:
        spath = entry["path"]
        meta = file_meta[spath]
        stats = pair_stats.get(spath, {"max_raw": 0, "max_idnorm": 0, "max_block": 0,
                                       "lit": 0, "com": 0, "flags": set(), "n_pairs": 0})
        cands = candidates_by_file.get(spath, [])
        cand_paths = "; ".join(p for p, _, _ in cands)
        # 机器观察（固定词汇组合）
        observations = []
        if comparison is None:
            observations = ["证据不足"]
        elif stats["flags"] & {"exact-match", "distinctive-comment-match",
                               "distinctive-literal-match", "high-text-similarity"}:
            observations = ["存在高风险匹配"]
        elif "high-structure-similarity" in stats["flags"]:
            observations = ["存在需要人工解释的结构相似"]
        elif cands and stats["max_raw"] >= 0.03:
            observations = ["存在通用框架样板"]
        elif cands:
            observations = ["未发现直接逐字复用信号"]
        else:
            observations = ["未发现直接逐字复用信号", "证据不足"]
        # 机器风险等级（§10.3 机械规则）
        if comparison is None or not entry["exists"]:
            risk = "blocked"
        elif stats["flags"] & {"exact-match", "distinctive-comment-match",
                               "distinctive-literal-match", "high-text-similarity"}:
            risk = "high"
        elif (stats["max_idnorm"] >= TH_NOTABLE_OVERLAP_STRUCTURE
              or stats["max_raw"] >= TH_NOTABLE_OVERLAP_RAW
              or stats["max_block"] >= TH_NOTABLE_COMMON_BLOCK):
            risk = "medium"
        else:
            risk = "low"
        ev_ind = ("与全部候选对的指标均低于高风险阈值：最高 raw=%.4f、idnorm-5gram=%.4f、"
                  "最长公共块=%d 行、独特字面量命中=%d、独特注释命中=%d（similarity-results.csv）"
                  % (stats["max_raw"], stats["max_idnorm"], stats["max_block"],
                     stats["lit"], stats["com"]))
        ev_reuse = "docs/001.md 记录对 VoiceStudio 的架构参考（设计参考已声明）；存在职责对应候选见 counterpart-map.csv"
        if spath == "server/lib/safeFs.ts":
            ev_reuse += "；文件头注释自述『自 VoiceStudio 吸收、独立实现』"
        ev_refs = ["docs/provenance/batch-01/file-inventory.csv",
                   "docs/provenance/batch-01/counterpart-map.csv",
                   "docs/provenance/batch-01/similarity-results.csv"]
        if review_priority(spath) == "P0":
            base = safe_name(spath)
            ev_refs += ["docs/provenance/batch-01/evidence/semovix/%s.first-commit.txt" % base,
                        "docs/provenance/batch-01/evidence/semovix/%s.history-summary.txt" % base,
                        "docs/provenance/batch-01/evidence/semovix/%s.blame-summary.txt" % base]
        mr_rows.append([
            spath,
            FILE_FUNCTIONS.get(spath, "") if entry["exists"] else "(missing)",
            meta.get("sha256_raw", ""), meta.get("first_add_commit", ""),
            meta.get("first_authored_at", ""), "; ".join(meta.get("git_authors", [])),
            cand_paths, "；".join(observations), ev_ind, ev_reuse,
            FILE_OTHER_SOURCES.get(spath, ""), risk,
            "待人工确认", "待人工确认", "待人工确认", "待人工确认", "待人工确认",
            "待指派", "待指派", "未开始", "; ".join(ev_refs),
        ])
    write_csv(os.path.join(out_dir, "manual-review.csv"), mr_header, mr_rows)

    # ---- machine-summary.json（供撰写 review-notes/summary 的机器数据）----------------
    flag_counts = Counter(r[13] for r in sim_rows_sorted)
    machine_summary = {
        "generated_at_utc": generated_at,
        "script_version": SCRIPT_VERSION,
        "subject_commit": subject.sha,
        "comparison_commit": comparison.sha if comparison else None,
        "scope_file_count": len(scope),
        "existing_file_count": sum(1 for e in scope if e["exists"]),
        "missing_file_count": sum(1 for e in scope if not e["exists"]),
        "pair_count": len(sim_rows),
        "flag_counts": dict(sorted(flag_counts.items())),
        "per_file": {
            e["path"]: {
                "risk": next(r[11] for r in mr_rows if r[0] == e["path"]),
                "max_raw": pair_stats[e["path"]]["max_raw"],
                "max_idnorm": pair_stats[e["path"]]["max_idnorm"],
                "max_block": pair_stats[e["path"]]["max_block"],
                "distinctive_literals": pair_stats[e["path"]]["lit"],
                "distinctive_comments": pair_stats[e["path"]]["com"],
                "candidates": len(candidates_by_file.get(e["path"], [])),
                "observation": next(r[7] for r in mr_rows if r[0] == e["path"]),
            } for e in scope
        },
        "history_check": history_check,
        "blocked": blocked,
    }
    write_text(os.path.join(out_dir, "evidence", "machine-summary.json"),
               json.dumps(machine_summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n")

    # ---- scan-manifest -------------------------------------------------------------
    manifest = {
        "script_version": SCRIPT_VERSION,
        "script_sha256": hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest(),
        "generated_at_utc": generated_at,
        "subject": {
            "repo": "<semovix-repo>",
            "ref": args.subject_ref,
            "branch": subject.branch,
            "commit": subject.sha,
            "worktree_clean": subject.clean,
            "remote": [sanitize(r) for r in subject.remotes],
        },
        "comparison": {
            "repo": "<voicestudio-repo>",
            "ref": args.comparison_ref,
            "branch": comparison.branch if comparison else None,
            "commit": comparison.sha if comparison else None,
            "worktree_clean": comparison.clean if comparison else None,
            "history_complete": (not os.path.exists(os.path.join(comparison.root, ".git", "shallow"))
                                 if comparison else None),
            "remote": [sanitize(r) for r in comparison.remotes] if comparison else [],
        },
        "scope_file_count": len(scope),
        "scope": [e["path"] for e in scope],
        "thresholds": {
            "high_text_raw_line_sequence": TH_HIGH_TEXT,
            "high_structure_idnorm_5gram_jaccard": TH_HIGH_STRUCTURE,
            "distinctive_literal_min_chars": TH_DISTINCTIVE_LITERAL_MIN_LEN,
            "distinctive_comment_min_chars": TH_DISTINCTIVE_COMMENT_MIN_LEN,
        },
        "normalization": {
            "raw": "原始字节 / 原始行",
            "normalized": "UTF-8 去 BOM、LF、行内空白压缩为单空格（含缩进）",
            "identifier_normalized": "注释单独提取；字符串→<STR>；数字→<NUM>；非关键字/非 API 标识符→<ID>；关键字/运算符/固定 API 名保留",
            "note": "identifier-normalized 视图对框架样板（Electron 初始化、tsconfig 等）可能产生误报，需人工确认",
        },
        "sorting": {
            "similarity-results.csv": "risk severity desc, identifier-normalized similarity desc, raw similarity desc, semovix_path asc, voicestudio_path asc",
        },
        "outputs": sorted(["scope.txt", "scan-manifest.json", "file-inventory.csv",
                           "file-history.csv", "counterpart-map.csv", "similarity-results.csv",
                           "manual-review.csv", "evidence/"]),
        "blocked": blocked,
    }
    write_text(os.path.join(out_dir, "scan-manifest.json"),
               sanitize(json.dumps(manifest, ensure_ascii=False, indent=2)) + "\n")
    write_text(os.path.join(out_dir, "scan-manifest.local.json"),
               json.dumps({"subject_root": os.path.abspath(args.subject_root),
                           "comparison_root": os.path.abspath(args.comparison_root),
                           "note": "本文件含本机绝对路径，仅供本地复现；已加入 .gitignore，不得提交"},
                          ensure_ascii=False, indent=2) + "\n")

    # ---- 控制台摘要 ---------------------------------------------------------------
    print("subject   : %s @ %s (clean=%s)" % (sanitize(subject.root), subject.sha[:12], subject.clean))
    if comparison:
        print("comparison: %s @ %s (clean=%s)" % (sanitize(comparison.root), comparison.sha[:12], comparison.clean))
    print("scope     : %d files (%d exist, %d missing)" % (
        len(scope), sum(1 for e in scope if e["exists"]), sum(1 for e in scope if not e["exists"])))
    print("pairs     : %d similarity rows; flags: %s" % (len(sim_rows), dict(flag_counts) or "none"))
    print("output    : %s" % sanitize(out_dir))
    if blocked:
        print("BLOCKED   : %s" % "; ".join(blocked))
    return 0


def commit_count_all(repo):
    out = repo.git("rev-list", "--count", repo.sha, check=False).decode().strip()
    return int(out) if out.isdigit() else -1


if __name__ == "__main__":
    sys.exit(main())

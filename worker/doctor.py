# -*- coding: utf-8 -*-
"""
Semovix Voice Worker 环境体检（P01 运行环境可移植性；P0-A #8 结构化输出）

逐项检查运行前提并输出 PASS / WARN / FAIL：

  1. Python 版本（>= 3.10）
  2. torch 及加速设备（MPS / CUDA / CPU）
  3. qwen_tts（Qwen3-TTS 引擎）
  4. transformers（Whisper 引擎）
  5. librosa / soundfile（音频解码）
  6. 四个模型 checkpoint（CustomVoice / VoiceDesign / Base / Whisper；
     本地目录存在 → 已找到；HF repo id → 首跑联网下载）
  7. FFmpeg（部分音频格式转码；WAV 主链路不依赖）
  8. Worker 端口是否已被占用（Worker 是否已在运行）
  9. 可写目录（当前目录 + 系统临时目录）

存在 FAIL 时以非零码退出（可用于启动前预检 / CI）。

用法：
  python worker/doctor.py           人类可读终端输出（含 Emoji）
  python worker/doctor.py --json    结构化 JSON（Electron 桌面壳依赖，禁止依赖解析终端文本）

JSON 结构：
  {
    "status": "pass" | "pass_with_warnings" | "fail",
    "python": {"path": "...", "version": "3.11.9"},
    "device": {"type": "mps" | "cuda" | "cpu" | "unknown", "name": "Apple M3 Max"},
    "checks": [{"id": "...", "state": "pass" | "warn" | "fail", "message": "..."}]
  }
"""
from __future__ import annotations

import importlib.util
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

# 只关闭 librosa 的可选 Numba JIT 缓存，不影响 Qwen 的 PyTorch 推理。
# Python 3.12 + 部分 librosa/numba 组合否则会在 qwen_tts 导入阶段失败。
os.environ.setdefault("NUMBA_DISABLE_JIT", "1")
_WORKER_ROOT = Path(__file__).resolve().parent

# doctor 可能被一个“裸解释器”运行（首配向导里用它验证环境本身），
# 此时连 python-dotenv 都可能缺失——绝不能因为导入失败而给不出结构化结果。
try:
    from dotenv import load_dotenv

    load_dotenv(_WORKER_ROOT.parent / ".env", override=False)
    load_dotenv(_WORKER_ROOT / ".env", override=False)
    _DOTENV_OK = True
except Exception:  # pragma: no cover - 裸解释器兜底
    _DOTENV_OK = False

WORKER_PORT = int(os.environ.get("SEMOVIX_WORKER_PORT", "8800"))
DEFAULT_TTS_CKPT = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
TTS_CKPT = os.environ.get("SEMOVIX_TTS_CKPT", DEFAULT_TTS_CKPT)
VOICE_DESIGN_CKPT = os.environ.get("SEMOVIX_VOICE_DESIGN_CKPT", "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign")
VOICE_CLONE_CKPT = os.environ.get("SEMOVIX_VOICE_CLONE_CKPT", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
ASR_MODEL_ID = os.environ.get("SEMOVIX_ASR_MODEL", "openai/whisper-large-v3-turbo")


@dataclass
class Check:
    """单项检查结果：id 供程序消费（稳定不变），label 供终端展示"""

    id: str
    state: str  # pass | warn | fail
    message: str = ""
    label: str = ""

    def __post_init__(self) -> None:
        if not self.label:
            self.label = self.id


@dataclass
class Report:
    checks: list[Check] = field(default_factory=list)

    def record(self, check: Check) -> None:
        self.checks.append(check)

    @property
    def status(self) -> str:
        states = {c.state for c in self.checks}
        if "fail" in states:
            return "fail"
        if "warn" in states:
            return "pass_with_warnings"
        return "pass"

    def find(self, check_id: str) -> Check | None:
        return next((c for c in self.checks if c.id == check_id), None)

    def exit_code(self) -> int:
        return 1 if self.status == "fail" else 0


def has_module(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def detect_device() -> tuple[str, str]:
    """(type, name)：torch 可导入时按 MPS/CUDA/CPU 判定；否则 unknown（由 torch 检查项另行报 FAIL）"""
    try:
        import torch

        if torch.backends.mps.is_available():
            return "mps", _macos_chip_name()
        if torch.cuda.is_available():
            return "cuda", torch.cuda.get_device_name(0)
        return "cpu", (platform.processor() or platform.machine() or "")
    except Exception:
        return "unknown", ""


def _macos_chip_name() -> str:
    if sys.platform != "darwin":
        return platform.machine() or "Apple Silicon"
    try:
        out = subprocess.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        return out.stdout.strip() or "Apple Silicon"
    except Exception:
        return "Apple Silicon"


def check_python(report: Report) -> None:
    v = sys.version_info
    version = f"{v.major}.{v.minor}.{v.micro}"
    if v >= (3, 10):
        report.record(Check("python", "pass", version, "Python"))
    else:
        report.record(Check("python", "fail", f"{version}（需要 >= 3.10）", "Python"))


def check_dotenv(report: Report) -> None:
    if _DOTENV_OK:
        report.record(Check("dotenv", "pass", "python-dotenv 可用", "python-dotenv"))
    else:
        report.record(
            Check("dotenv", "warn", "未安装 python-dotenv（.env 不会被加载；pip install -r requirements-base.txt）", "python-dotenv")
        )


def check_torch(report: Report, device_type: str, device_name: str) -> None:
    if not has_module("torch"):
        report.record(Check("torch", "fail", "未安装（按平台装 requirements-macos.txt / requirements-cuda.txt）", "torch"))
        return
    try:
        import torch

        slow = device_type == "cpu"
        detail = f"{torch.__version__} · 设备 {device_type}"
        if device_name:
            detail += f"（{device_name}）"
        if slow:
            detail += "（无加速后端，合成/转写会很慢）"
        report.record(Check("torch", "warn" if slow else "pass", detail, "torch"))
    except Exception as e:  # pragma: no cover - 环境异常兜底
        report.record(Check("torch", "fail", f"导入失败: {e}", "torch"))


def check_module(report: Report, name: str, label: str, on_fail: str = "fail") -> None:
    if has_module(name):
        try:
            mod = importlib.import_module(name)
            report.record(Check(_module_check_id(name), "pass", getattr(mod, "__version__", ""), label))
        except Exception as e:
            report.record(Check(_module_check_id(name), "fail", f"导入失败: {e}", label))
    else:
        report.record(
            Check(_module_check_id(name), on_fail, "未安装（pip install -r requirements-base.txt）", label)
        )


def _module_check_id(name: str) -> str:
    return f"module-{name}"


def check_checkpoint(report: Report, check_id: str, label: str, checkpoint: str) -> None:
    if os.path.isdir(checkpoint):
        report.record(Check(check_id, "pass", f"本地目录 {checkpoint}", label))
        return
    if "/" in checkpoint and not os.path.exists(checkpoint):
        # 形如 org/name 的 HuggingFace repo id：首次运行需联网下载
        report.record(
            Check(
                check_id,
                "warn",
                f"HuggingFace repo id {checkpoint}（首次运行将联网下载，约 4-5GB；"
                "本机已有权重可通过对应 SEMOVIX_*_CKPT 指向本地目录）",
                label,
            ),
        )
        return
    report.record(Check(check_id, "fail", f"checkpoint 路径不存在: {checkpoint}", label))


def check_ffmpeg(report: Report) -> None:
    for binname in ("ffmpeg", "ffprobe"):
        if not shutil.which(binname):
            report.record(Check("ffmpeg", "warn", f"未找到 {binname}（WAV 主链路不依赖；部分格式转码需要）", "FFmpeg"))
            return
    report.record(Check("ffmpeg", "pass", "ffmpeg / ffprobe 可用", "FFmpeg"))


def check_port(report: Report) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        occupied = s.connect_ex(("127.0.0.1", WORKER_PORT)) == 0
    label = f"端口 {WORKER_PORT}"
    if occupied:
        report.record(
            Check("worker-port", "warn", "已被占用（Worker 已在运行？否则请释放端口或用 SEMOVIX_WORKER_PORT 换端口）", label)
        )
    else:
        report.record(Check("worker-port", "pass", "空闲", label))


def check_writable(report: Report) -> None:
    for label, path in (("工作目录", os.getcwd()), ("临时目录", tempfile.gettempdir())):
        try:
            probe = os.path.join(path, f".semovix-doctor-{os.getpid()}")
            with open(probe, "w") as f:
                f.write("ok")
            os.remove(probe)
        except Exception as e:
            report.record(Check("writable-dir", "fail", f"{path} 不可写: {e}", f"可写目录·{label}"))
            return
    report.record(Check("writable-dir", "pass", "工作目录与临时目录均可写", "可写目录"))


def run_all_checks() -> Report:
    report = Report()
    check_python(report)
    check_dotenv(report)
    device_type, device_name = detect_device()
    check_torch(report, device_type, device_name)
    check_module(report, "qwen_tts", "qwen_tts")
    check_module(report, "transformers", "transformers")
    check_module(report, "librosa", "librosa", on_fail="warn")
    check_module(report, "soundfile", "soundfile", on_fail="warn")
    check_checkpoint(report, "model-customvoice", "CustomVoice checkpoint", TTS_CKPT)
    check_checkpoint(report, "model-voice-design", "VoiceDesign checkpoint", VOICE_DESIGN_CKPT)
    check_checkpoint(report, "model-base", "Base checkpoint", VOICE_CLONE_CKPT)
    check_checkpoint(report, "model-whisper", "Whisper checkpoint", ASR_MODEL_ID)
    check_ffmpeg(report)
    check_port(report)
    check_writable(report)
    return report


def render_text(report: Report) -> str:
    lines = [
        "Semovix Voice Worker 环境体检",
        f"  Python: {sys.executable}",
        f"  CustomVoice checkpoint: {TTS_CKPT}",
        "-" * 64,
    ]
    width = max(len(c.label) for c in report.checks)
    fails = warns = 0
    for c in report.checks:
        mark = {"pass": "✅ PASS", "warn": "⚠️  WARN", "fail": "❌ FAIL"}[c.state]
        line = f"{mark}  {c.label.ljust(width)}"
        if c.message:
            line += f"  {c.message}"
        lines.append(line)
        fails += c.state == "fail"
        warns += c.state == "warn"
    lines.append("-" * 64)
    if fails:
        lines.append(f"结论：FAIL（{fails} 项失败，{warns} 项警告）——请先修复失败项再启动 Worker。")
    else:
        lines.append(f"结论：{'PASS' if warns == 0 else 'PASS（带警告）'}（0 项失败，{warns} 项警告）")
    return "\n".join(lines)


def render_json(report: Report) -> str:
    device_type, device_name = detect_device()
    payload = {
        "status": report.status,
        "python": {"path": sys.executable, "version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"},
        "device": {"type": device_type, "name": device_name},
        "checks": [{"id": c.id, "state": c.state, "message": c.message} for c in report.checks],
    }
    # ensure_ascii=False 保留中文；终端文本里的 Emoji 绝不出现在 JSON 通道
    return json.dumps(payload, ensure_ascii=False, indent=2)


def main() -> int:
    report = run_all_checks()
    if "--json" in sys.argv[1:]:
        print(render_json(report))
    else:
        print(render_text(report))
    return report.exit_code()


if __name__ == "__main__":
    sys.exit(main())

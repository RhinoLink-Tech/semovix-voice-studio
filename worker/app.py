# -*- coding: utf-8 -*-
"""
Semovix Voice Studio - Python FastAPI Worker（硬性约束 #14）

独立进程承载本地引擎，Node 后端只与本 Worker 通信：
  - Qwen3-TTS (Qwen3-TTS-12Hz-1.7B-CustomVoice)
  - Qwen3-TTS (Qwen3-TTS-12Hz-1.7B-VoiceDesign)
  - Qwen3-TTS (Qwen3-TTS-12Hz-1.7B-Base, 授权真人克隆)
  - Whisper   (openai/whisper-large-v3-turbo)

引擎冷启动状态机（P01）：

    cold ──warmup──▶ loading ──成功──▶ ready ──unload/空闲淘汰──▶ cold
                        │                │
                        └──失败──▶ error └──推理 OOM──▶ error（载荷已释放，显式 warmup 重载）
                            └─再次 warmup─▶ loading

模型生命周期与资源治理（P0-B #19-23）：
  - #19 /health 每引擎自述 capabilities（design/clone/presetVoice/transcription、
    languages、supportsSeed/supportsReferenceAudio/supportsStreaming），页面不得按模型名猜能力
  - #20 /health 每引擎上报 modelInfo（repoId/revision/本地权重指纹/runtime/torch 版本/设备），
    供 Node 冻结进 Voice Profile Manifest，防静默升级
  - #21 显式 POST /unload/{segment}、空闲自动卸载（SEMOVIX_IDLE_UNLOAD_SECONDS，0 关闭）、
    推理 OOM 后释放载荷且不自动重启循环
  - #22 折中方案：大型 Qwen 模型（qwen_tts/voice_design/voice_clone）同一时刻只允许一个常驻，
    切换（warmup 另一个大模型）即显式卸载既有常驻者；在途推理结束后再卸载（延迟淘汰）
  - #23 每引擎推理并发 = 1（infer_lock）；推理在 FastAPI 线程池执行，不阻塞事件循环（/health 永远可达）

  - GET  /health          永不触发加载；进程可达即 200，如实上报各引擎 state
  - POST /warmup/qwen     ready → 200；cold/loading → 202 {retry:true}；error → 503 {retry:true}（同时触发重载）
  - POST /unload/qwen     ready 且空闲 → 200 {state:"cold"}；推理中 → 409 engine_busy
  - GET  /voices          不触发加载；未就绪 → 503 engine_not_ready
  - POST /tts/qwen        不触发加载；未就绪 → 503 engine_not_ready
  - POST /asr/whisper     不触发加载；未就绪 → 503 engine_not_ready

音频传输一律文件/字节流，不走 JSON Base64（硬性约束 #7）。
"""
from __future__ import annotations

import contextlib
import gc
import hashlib
import io
import os
import threading
import time
import wave
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

# 与 Node 服务使用同一份项目环境配置。先保留进程显式传入的变量，再加载
# worker/.env 与项目根 .env，便于本机路径和部署密钥都只维护一处。
_WORKER_ROOT = Path(__file__).resolve().parent
load_dotenv(_WORKER_ROOT.parent / ".env", override=False)
load_dotenv(_WORKER_ROOT / ".env", override=False)

# 模型 checkpoint：默认 HuggingFace repo id（可移植；首次启动自动下载）。
# 本机已有权重时用 SEMOVIX_TTS_CKPT 指向本地目录，避免重复下载。
DEFAULT_TTS_CKPT = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
TTS_CKPT = os.environ.get("SEMOVIX_TTS_CKPT", DEFAULT_TTS_CKPT)
VOICE_DESIGN_CKPT = os.environ.get("SEMOVIX_VOICE_DESIGN_CKPT", "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign")
VOICE_CLONE_CKPT = os.environ.get("SEMOVIX_VOICE_CLONE_CKPT", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
ASR_MODEL_ID = os.environ.get("SEMOVIX_ASR_MODEL", "openai/whisper-large-v3-turbo")

# #20 版本精确锁定：可选 pin 到 HF 具体 revision（commit 或 tag）。qwen-tts 0.1.1 的
# from_pretrained 会把 **kwargs 原样透传给 transformers AutoModel，revision= 直达 HF。
TTS_REVISION = os.environ.get("SEMOVIX_TTS_REVISION") or None
VOICE_DESIGN_REVISION = os.environ.get("SEMOVIX_VOICE_DESIGN_REVISION") or None
VOICE_CLONE_REVISION = os.environ.get("SEMOVIX_VOICE_CLONE_REVISION") or None
ASR_REVISION = os.environ.get("SEMOVIX_ASR_REVISION") or None
_REVISIONS: dict[str, Optional[str]] = {
    "qwen_tts": TTS_REVISION,
    "voice_design": VOICE_DESIGN_REVISION,
    "voice_clone": VOICE_CLONE_REVISION,
    "whisper_asr": ASR_REVISION,
}

# #21 空闲自动卸载：引擎 ready 且无在途推理超过 N 秒 → 释放权重（0 = 关闭）。
IDLE_UNLOAD_SECONDS = float(os.environ.get("SEMOVIX_IDLE_UNLOAD_SECONDS", "1800"))
# 巡检间隔（默认取空闲阈值的 1/10，夹在 [5s, 60s]）；测试可调小。
IDLE_SWEEP_INTERVAL = float(os.environ.get("SEMOVIX_IDLE_SWEEP_INTERVAL", "0") or 0) or max(5.0, min(60.0, IDLE_UNLOAD_SECONDS / 10))

app = FastAPI(title="Semovix Voice Worker", version="1.2.0")


# ---------------------------------------------------------------------------
# 引擎状态机：cold → loading → ready | error（线程安全，加载在后台线程执行）
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class EngineState:
    id: str
    state: str = "cold"  # cold | loading | ready | error
    error: Optional[str] = None
    load_started_at: Optional[str] = None
    loaded_at: Optional[str] = None
    load_attempts: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    # #23 每引擎推理并发 = 1：所有推理端点在 infer_lock 内执行
    infer_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    in_flight: int = 0  # 当前在途推理数（0/1，受 infer_lock 约束）
    # #21 生命周期记账
    last_used_at: Optional[str] = None
    # #22 延迟淘汰标记：切换大模型时对方在途推理，结束后由 _inference 收尾卸载
    evict_pending: bool = False
    # 以下载荷仅在 state == "ready" 时有效
    model: Any = None
    processor: Any = None
    speakers: list = field(default_factory=list)
    languages: list = field(default_factory=list)
    device: Optional[str] = None
    dtype: Any = None
    dtype_name: Optional[str] = None
    checkpoint: Optional[str] = None
    # #20 模型身份：本地权重指纹（加载时计算）；revision 来自环境变量 pin
    fingerprint: Optional[str] = None
    revision: Optional[str] = None


_TTS = EngineState(id="qwen_tts")
_VOICE_DESIGN = EngineState(id="voice_design")
_VOICE_CLONE = EngineState(id="voice_clone")
_ASR = EngineState(id="whisper_asr")
_ENGINES: dict[str, EngineState] = {"qwen_tts": _TTS, "voice_design": _VOICE_DESIGN, "voice_clone": _VOICE_CLONE, "whisper_asr": _ASR}

# #22 折中方案：大型 Qwen 模型集合——同一时刻只允许一个常驻
_BIG_ENGINES = ("qwen_tts", "voice_design", "voice_clone")


def _all_engine_states() -> list[EngineState]:
    """经模块全局取引擎（测试会 monkeypatch _TTS 等引用，不能缓存成局部列表）"""
    return [_TTS, _VOICE_DESIGN, _VOICE_CLONE, _ASR]


def _pick_device() -> str:
    import torch

    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda:0"
    return "cpu"


def _build_tts() -> dict[str, Any]:
    """真实加载 Qwen3-TTS（测试通过替换 _BUILDERS 注入伪模型）"""
    import torch
    from qwen_tts import Qwen3TTSModel

    device = _pick_device()
    # 与既有 qwen-tts-demo 运行参数一致：MPS + bf16 + 不用 flash-attn
    dtype = torch.bfloat16 if device == "mps" else torch.float32
    tts = Qwen3TTSModel.from_pretrained(TTS_CKPT, device_map=device, dtype=dtype, attn_implementation=None, revision=TTS_REVISION)
    return {
        "model": tts,
        "speakers": list(tts.get_supported_speakers() or []),
        "languages": list(tts.get_supported_languages() or []),
        "device": device,
        "dtype": dtype,
        "checkpoint": TTS_CKPT,
    }


def _build_voice_design() -> dict[str, Any]:
    """VoiceDesign 单独加载；绝不复用 CustomVoice 权重或 speaker 命名空间。"""
    import torch
    from qwen_tts import Qwen3TTSModel

    device = _pick_device()
    dtype = torch.bfloat16 if device == "mps" else torch.float32
    model = Qwen3TTSModel.from_pretrained(
        VOICE_DESIGN_CKPT, device_map=device, dtype=dtype, attn_implementation=None, revision=VOICE_DESIGN_REVISION
    )
    return {"model": model, "device": device, "dtype": dtype, "checkpoint": VOICE_DESIGN_CKPT}


def _build_voice_clone() -> dict[str, Any]:
    """Base 单独加载；真人克隆不能误用 CustomVoice 或 VoiceDesign checkpoint。"""
    import torch
    from qwen_tts import Qwen3TTSModel

    device = _pick_device()
    dtype = torch.bfloat16 if device == "mps" else torch.float32
    model = Qwen3TTSModel.from_pretrained(
        VOICE_CLONE_CKPT, device_map=device, dtype=dtype, attn_implementation=None, revision=VOICE_CLONE_REVISION
    )
    return {"model": model, "device": device, "dtype": dtype, "checkpoint": VOICE_CLONE_CKPT}


def _build_asr() -> dict[str, Any]:
    """真实加载 Whisper（测试通过替换 _BUILDERS 注入伪模型）"""
    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    device = _pick_device()
    dtype = torch.float16 if device == "mps" else torch.float32
    kwargs: dict[str, Any] = {"revision": ASR_REVISION} if ASR_REVISION else {}
    processor = WhisperProcessor.from_pretrained(ASR_MODEL_ID, **kwargs)
    model = WhisperForConditionalGeneration.from_pretrained(ASR_MODEL_ID, torch_dtype=dtype, **kwargs).to(device)
    return {"model": model, "processor": processor, "device": device, "dtype": dtype}


_BUILDERS: dict[str, Callable[[], dict[str, Any]]] = {"qwen_tts": _build_tts, "voice_design": _build_voice_design, "voice_clone": _build_voice_clone, "whisper_asr": _build_asr}


# ---------------------------------------------------------------------------
# #20 模型身份：本地权重指纹与运行时版本
# ---------------------------------------------------------------------------

_WEIGHT_SUFFIXES = {".safetensors", ".bin", ".pt", ".pth", ".onnx", ".msgpack", ".h5"}
_FINGERPRINT_META_BUDGET = 8 * 1024 * 1024  # 小文件（config/tokenizer）按内容哈希的总预算
_VERSION_CACHE: dict[str, Optional[str]] = {}


def _fingerprint_dir(path: Path) -> Optional[str]:
    """
    本地 checkpoint 目录指纹（#20）：小文件（config/tokenizer，≤8MB 总量）按内容 SHA-256，
    权重文件按 (相对路径, 大小, mtime_ns) 记账——多 GB 权重不做全量内容哈希，
    权重字节级变化会体现在 size/mtime 上，足以发现"目录被静默升级/替换"。
    """
    try:
        files = [f for f in sorted(path.rglob("*")) if f.is_file()][:512]
    except OSError:
        return None
    digest = hashlib.sha256()
    meta_bytes = 0
    for f in files:
        try:
            rel = str(f.relative_to(path))
            stat = f.stat()
        except OSError:
            continue
        if f.suffix.lower() in _WEIGHT_SUFFIXES or stat.st_size > 4 * 1024 * 1024:
            digest.update(f"{rel}|{stat.st_size}|{stat.st_mtime_ns}\n".encode())
            continue
        if meta_bytes + stat.st_size > _FINGERPRINT_META_BUDGET:
            digest.update(f"{rel}|{stat.st_size}|{stat.st_mtime_ns}\n".encode())
            continue
        try:
            content_digest = hashlib.sha256(f.read_bytes()).hexdigest()
        except OSError:
            content_digest = "unreadable"
        meta_bytes += stat.st_size
        digest.update(f"{rel}|{stat.st_size}|{content_digest}\n".encode())
    return digest.hexdigest()[:16] if files else None


def _package_version(dist: str) -> Optional[str]:
    if dist not in _VERSION_CACHE:
        try:
            from importlib import metadata

            _VERSION_CACHE[dist] = metadata.version(dist)
        except Exception:  # noqa: BLE001 - 环境未装该包时如实报 None
            _VERSION_CACHE[dist] = None
    return _VERSION_CACHE[dist]


def _torch_version() -> Optional[str]:
    try:
        import torch

        return getattr(torch, "__version__", None)
    except Exception:  # noqa: BLE001
        return None


def _runtime_version(es_id: str) -> Optional[str]:
    """推理运行时版本：TTS 引擎报 qwen-tts 包，Whisper 报 transformers 包"""
    return _package_version("qwen-tts" if es_id != "whisper_asr" else "transformers")


def _model_info(es: EngineState, default_repo: str) -> dict[str, Any]:
    repo = es.checkpoint or default_repo
    local_path: Optional[str] = None
    try:
        if repo and Path(repo).is_dir():
            local_path = repo
    except OSError:
        local_path = None
    return {
        "provider": "OpenAI" if es.id == "whisper_asr" else "Qwen",
        "repoId": repo,
        "revision": es.revision or _REVISIONS.get(es.id),
        "localPath": local_path,
        "localPathFingerprint": es.fingerprint,
        "runtimeVersion": _runtime_version(es.id),
        "torchVersion": _torch_version(),
        "deviceType": es.device,
        "dtype": es.dtype_name,
    }


# ---------------------------------------------------------------------------
# #19 引擎能力合同：模型自述能力，页面不得按模型名猜测
# ---------------------------------------------------------------------------

_ENGINE_CAPABILITIES: dict[str, dict[str, Any]] = {
    "qwen_tts": {
        "presetVoice": True, "design": False, "clone": False, "transcription": False,
        "languages": [],  # 目录只有运行时权威：ready 后由模型目录填充
        "sampleRateHz": 24000,
        "supportsSeed": False, "supportsReferenceAudio": False, "supportsStreaming": False,
    },
    "voice_design": {
        "presetVoice": False, "design": True, "clone": False, "transcription": False,
        "languages": ["Chinese", "English", "Auto"],
        "sampleRateHz": 24000,
        "supportsSeed": True, "supportsReferenceAudio": False, "supportsStreaming": False,
    },
    "voice_clone": {
        "presetVoice": False, "design": False, "clone": True, "transcription": False,
        "languages": ["Chinese", "English", "Auto"],
        "sampleRateHz": 24000,
        "supportsSeed": False, "supportsReferenceAudio": True, "supportsStreaming": False,
    },
    "whisper_asr": {
        "presetVoice": False, "design": False, "clone": False, "transcription": True,
        "languages": ["auto", "zh", "en"],
        "sampleRateHz": None,
        "supportsSeed": False, "supportsReferenceAudio": False, "supportsStreaming": False,
    },
}


def _capabilities(es: EngineState) -> dict[str, Any]:
    caps = dict(_ENGINE_CAPABILITIES[es.id])
    if caps["languages"] == [] and es.languages:
        caps["languages"] = list(es.languages)  # qwen_tts：以运行时目录为准
    return caps


# ---------------------------------------------------------------------------
# #21/#23 卸载、显存释放、推理串行化
# ---------------------------------------------------------------------------


def _free_device_memory() -> None:
    """尽力释放：Python 引用 + CUDA/MPS 分配器缓存。失败不影响状态机。"""
    gc.collect()
    try:
        import torch

        if hasattr(torch, "cuda") and torch.cuda.is_available():
            torch.cuda.empty_cache()
        if hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache"):
            torch.mps.empty_cache()  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass


def _clear_payload(es: EngineState) -> None:
    es.model = None
    es.processor = None
    es.speakers = []
    es.languages = []
    es.device = None
    es.dtype = None
    es.dtype_name = None
    es.checkpoint = None
    es.fingerprint = None
    es.revision = None


def _release_engine(es: EngineState, *, to_state: str, error: Optional[str] = None) -> str:
    """
    释放引擎载荷并转入 to_state。调用方不得持有 es.lock / es.infer_lock。
    推理在途（infer_lock 被占）时标记 evict_pending 并保持原状态，由 _inference 收尾卸载。
    """
    with es.lock:
        if es.state not in ("ready", "error"):
            return es.state
        if not es.infer_lock.acquire(timeout=2.0):
            es.evict_pending = True
            return es.state
        try:
            if es.in_flight > 0:  # 防御：infer_lock 已持有则不应发生
                es.evict_pending = True
                return es.state
            _clear_payload(es)
            es.state = to_state
            es.error = error
            es.loaded_at = None
            es.last_used_at = None
            es.evict_pending = False
        finally:
            es.infer_lock.release()
    _free_device_memory()
    return to_state


def _unload_engine(es: EngineState) -> str:
    """#21 主动卸载：ready/error → cold（释放权重与显存缓存）"""
    return _release_engine(es, to_state="cold")


def _evict_other_big_engines(exclude_id: str) -> None:
    """#22 折中方案：切换大模型时显式卸载既有常驻者；在途推理 → 延迟淘汰"""
    for es in (_TTS, _VOICE_DESIGN, _VOICE_CLONE):
        if es.id == exclude_id:
            continue
        with es.lock:
            if es.state != "ready":
                es.evict_pending = False
                continue
            if es.in_flight > 0:
                es.evict_pending = True
                print(f"[worker] {es.id} 在途推理，标记延迟卸载（切换到 {exclude_id}）", flush=True)
                continue
        before = es.state
        result = _unload_engine(es)
        if result == "cold" and before == "ready":
            print(f"[worker] {es.id} 已卸载（切换到 {exclude_id}，单常驻约束）", flush=True)


@contextlib.contextmanager
def _inference(es: EngineState) -> Iterator[None]:
    """
    #23 每引擎并发 = 1：推理端点统一经此上下文进入（串行 + in_flight/last_used_at 记账）。
    退出后若带 evict_pending（#22 延迟淘汰），在锁外异步卸载，避免与 infer_lock 嵌套死锁。
    拿到锁后复核 ready：排队等待期间引擎可能被切换卸载，避免对已释放载荷产生误导性崩溃。
    """
    with es.infer_lock:
        if es.state != "ready":
            raise RuntimeError(f"{es.id} 引擎在排队期间被卸载（state={es.state}），请重新预热后重试")
        es.in_flight += 1
        es.last_used_at = _now_iso()
        try:
            yield
        finally:
            es.in_flight -= 1
            evict = es.evict_pending
    if evict:
        threading.Thread(target=_unload_engine, args=(es,), daemon=True, name=f"evict-{es.id}").start()


_OOM_MARKERS = ("out of memory", "cuda oom", "resourceexhausted", "显存不足", "内存不足", "mps backend out of", "allocation on device")


def _looks_like_oom(exc: BaseException) -> bool:
    """#21/#23 OOM 特征识别：异常类名（OutOfMemoryError/MemoryError）或消息特征"""
    name = type(exc).__name__.lower()
    if "outofmemory" in name or name == "memoryerror":
        return True
    message = str(exc).lower()
    return any(marker in message for marker in _OOM_MARKERS)


def _handle_oom(es: EngineState, exc: BaseException) -> None:
    """#21 OOM 后资源清理：释放载荷 → state=error；恢复靠显式 warmup，绝不自动重启循环"""
    print(f"[worker] {es.id} 推理显存不足，释放模型载荷：{exc}", flush=True)
    _release_engine(es, to_state="error", error=f"显存不足（已自动卸载模型）：{type(exc).__name__}: {exc}")


def _load_engine(es: EngineState) -> None:
    """后台线程中执行真实加载；任何异常 → state=error（带真实原因），进程不崩溃。"""
    try:
        payload = _BUILDERS[es.id]()
    except Exception as e:  # noqa: BLE001 - 状态如实上报，不崩溃
        es.error = f"{type(e).__name__}: {e}"
        es.state = "error"
        print(f"[worker] {es.id} 加载失败（第 {es.load_attempts} 次）: {es.error}", flush=True)
        return

    # 先写载荷再置 ready，保证读到 ready 时载荷一定完整
    es.model = payload.get("model")
    es.processor = payload.get("processor")
    es.speakers = payload.get("speakers", [])
    es.languages = payload.get("languages", [])
    es.device = payload.get("device")
    es.dtype = payload.get("dtype")
    dtype_value = payload.get("dtype")
    es.dtype_name = str(dtype_value) if dtype_value is not None else None
    es.checkpoint = payload.get("checkpoint")
    es.revision = _REVISIONS.get(es.id)
    es.error = None
    # #20 本地目录 → 计算权重指纹（加载线程内做，不挡 /health）
    if es.checkpoint:
        try:
            if Path(es.checkpoint).is_dir():
                es.fingerprint = _fingerprint_dir(Path(es.checkpoint))
        except OSError:
            es.fingerprint = None
    es.loaded_at = _now_iso()
    es.state = "ready"
    print(f"[worker] {es.id} 就绪 device={es.device}", flush=True)
    # #22 单常驻兜底：并发 warmup 竞态下可能出现两个大模型先后就绪，后到者驱逐先到者
    if es.id in _BIG_ENGINES:
        _evict_other_big_engines(es.id)


def _request_load(es: EngineState) -> None:
    """cold/error → 启动后台加载线程；loading/ready → 不重复加载（幂等）。"""
    with es.lock:
        if es.state in ("loading", "ready"):
            return
        es.state = "loading"
        es.error = None
        es.load_attempts += 1
        es.load_started_at = _now_iso()
    # #22 折中方案：加载大模型前显式卸载其他常驻大模型（锁外执行，避免与 es.lock 嵌套）
    if es.id in _BIG_ENGINES:
        _evict_other_big_engines(es.id)
    threading.Thread(target=_load_engine, args=(es,), daemon=True, name=f"load-{es.id}").start()


def _snapshot(es: EngineState) -> dict[str, Any]:
    return {
        "state": es.state,
        "available": es.state == "ready",
        "error": es.error,
        "loadStartedAt": es.load_started_at,
        "loadedAt": es.loaded_at,
        "loadAttempts": es.load_attempts,
        # #21 生命周期记账
        "lastUsedAt": es.last_used_at,
        "inFlight": es.in_flight,
        "evictPending": es.evict_pending,
        # #19 能力合同 / #20 模型身份
        "capabilities": _capabilities(es),
        "modelInfo": _model_info(es, _default_repo(es.id)),
    }


def _default_repo(es_id: str) -> str:
    return {"qwen_tts": TTS_CKPT, "voice_design": VOICE_DESIGN_CKPT, "voice_clone": VOICE_CLONE_CKPT, "whisper_asr": ASR_MODEL_ID}[es_id]


_WARMUP_PATH = {"qwen_tts": "qwen", "voice_design": "voice-design", "voice_clone": "voice-clone", "whisper_asr": "whisper"}
_UNLOAD_PATH = _WARMUP_PATH  # 卸载路由段与预热一致：/unload/{qwen|voice-design|voice-clone|whisper}


def _require_ready(es: EngineState) -> None:
    """推理端点守卫：未就绪一律 503 engine_not_ready（绝不内联加载，避免请求线程被模型加载卡死）"""
    if es.state != "ready":
        hint = es.error or f"模型尚未加载，请先 POST /warmup/{_WARMUP_PATH[es.id]} 并轮询 /health 至 ready"
        raise HTTPException(
            status_code=503,
            detail={
                "error": f"{es.id} 引擎未就绪（state={es.state}）：{hint}",
                "code": "engine_not_ready",
                "engine": es.id,
                "state": es.state,
                "retry": es.state in ("cold", "loading"),
            },
        )


# ---------------------------------------------------------------------------
# 进程内存采样（#21：UI 能看到当前哪个模型占着资源）
# ---------------------------------------------------------------------------

_MEM_LOCK = threading.Lock()
_MEM_CACHE: dict[str, Any] = {"at": 0.0, "residentMb": None, "peakMb": None}


def _process_memory() -> dict[str, Optional[float]]:
    """进程 RSS（5s 缓存；psutil 可得则用之）与峰值 RSS。失败如实报 None。"""
    now = time.monotonic()
    with _MEM_LOCK:
        if now - float(_MEM_CACHE["at"]) < 5.0:
            return {"residentMb": _MEM_CACHE["residentMb"], "peakMb": _MEM_CACHE["peakMb"]}
    resident: Optional[float] = None
    peak: Optional[float] = None
    try:
        import resource

        raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        peak = raw / (1024 * 1024) if os.uname().sysname == "Darwin" else raw / 1024
    except Exception:  # noqa: BLE001
        pass
    try:
        import psutil

        resident = psutil.Process().memory_info().rss / (1024 * 1024)
        if peak is None:
            peak = psutil.Process().memory_info()._asdict().get("vms", 0) / (1024 * 1024) or None
    except Exception:  # noqa: BLE001
        pass
    if resident is None:
        try:
            import subprocess

            out = subprocess.run(  # noqa: S603 - 固定参数调用本机 ps
                ["ps", "-o", "rss=", "-p", str(os.getpid())], capture_output=True, text=True, timeout=5
            ).stdout.strip()
            resident = int(out) / 1024.0  # ps 报 KB
        except Exception:  # noqa: BLE001
            pass
    with _MEM_LOCK:
        _MEM_CACHE.update({"at": now, "residentMb": resident, "peakMb": peak})
    return {"residentMb": resident, "peakMb": peak}


def _sweep_idle_once(now: Optional[float] = None) -> list[str]:
    """#21 空闲巡检一轮：ready 且无在途推理、超过阈值未使用的大模型 → 卸载。返回被卸载的引擎 id。"""
    unloaded: list[str] = []
    threshold = IDLE_UNLOAD_SECONDS  # 读模块全局：测试可 monkeypatch
    if threshold <= 0:
        return unloaded
    now = now if now is not None else time.time()
    for es in _all_engine_states():
        with es.lock:
            if es.state != "ready" or es.in_flight > 0 or es.evict_pending:
                continue
            stamp = es.last_used_at or es.loaded_at
            if not stamp:
                continue
            try:
                last_use = datetime.fromisoformat(stamp).timestamp()
            except ValueError:
                continue
            if now - last_use < threshold:
                continue
        if _unload_engine(es) == "cold":
            unloaded.append(es.id)
            print(f"[worker] {es.id} 空闲超过 {threshold:.0f}s，自动卸载", flush=True)
    return unloaded


def _idle_sweeper_loop() -> None:
    while True:
        time.sleep(IDLE_SWEEP_INTERVAL)
        try:
            _sweep_idle_once()
        except Exception as e:  # noqa: BLE001 - 巡检线程绝不带崩进程
            print(f"[worker] 空闲巡检异常: {e}", flush=True)


if IDLE_UNLOAD_SECONDS > 0:
    threading.Thread(target=_idle_sweeper_loop, daemon=True, name="idle-sweeper").start()


# ---------------------------------------------------------------------------
# TTS
# ---------------------------------------------------------------------------


class TtsRequest(BaseModel):
    text: str = Field(min_length=1)
    speaker: str = Field(min_length=1)
    language: str = "auto"
    instruct: Optional[str] = None


class VoiceDesignRequest(BaseModel):
    text: str = Field(min_length=1)
    instruct: str = Field(min_length=1)
    language: str = "Chinese"
    seed: Optional[int] = None


def _float_to_wav_bytes(wav: Any, sample_rate: int) -> bytes:
    """float32 ndarray → 16-bit PCM RIFF/WAV 字节"""
    import numpy as np

    arr = np.asarray(wav, dtype=np.float32)
    if arr.ndim > 1:
        arr = arr.mean(axis=tuple(range(1, arr.ndim)))  # 多声道 → 单声道
    peak = float(np.max(np.abs(arr))) if arr.size else 0.0
    if peak > 0:
        arr = arr / peak * 0.95  # 防削波
    pcm = (arr * 32767.0).astype("<i2")

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


@app.post("/tts/qwen")
def tts_qwen(req: TtsRequest) -> Response:
    _require_ready(_TTS)

    speakers = _TTS.speakers
    # 硬性约束 #6：speaker 必须是官方精确 ID，不接受展示名/别名
    if speakers and req.speaker not in speakers:
        raise HTTPException(
            status_code=400,
            detail={
                "error": f"非官方 Qwen speaker ID: {req.speaker}（官方: {', '.join(speakers)}）",
                "code": "unsupported_speaker",
                "engine": "qwen_tts",
                "speakers": speakers,
            },
        )
    # 不同 Qwen checkpoint 会返回 `auto/chinese` 或 `Auto/Chinese`。由运行时
    # 目录做大小写无关匹配，再把模型返回的精确值传回推理层，不能写死一套枚举。
    language_by_key = {str(language).casefold(): str(language) for language in (_TTS.languages or [])}
    language = language_by_key.get(req.language.strip().casefold())
    if not language:
        raise HTTPException(
            status_code=400,
            detail={
                "error": f"不支持的语言: {req.language}",
                "code": "unsupported_language",
                "engine": "qwen_tts",
                "languages": _TTS.languages,
            },
        )

    try:
        with _inference(_TTS):  # #23 并发 = 1 + 使用记账
            wavs, sr = _TTS.model.generate_custom_voice(
                text=req.text.strip(),
                language=language,
                speaker=req.speaker,
                instruct=(req.instruct or "").strip() or None,
            )
        if not wavs:
            raise RuntimeError("模型未返回音频")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        if _looks_like_oom(e):
            _handle_oom(_TTS, e)  # #21 OOM → 释放载荷，显式 warmup 才重载
            raise HTTPException(status_code=502, detail={"error": f"显存不足，模型已卸载，请重新预热后重试：{e}", "code": "resource_exhausted", "engine": "qwen_tts"})
        raise HTTPException(status_code=502, detail={"error": f"{type(e).__name__}: {e}", "code": "tts_failed", "engine": "qwen_tts"})

    return Response(content=_float_to_wav_bytes(wavs[0], sr), media_type="audio/wav", headers={"X-Sample-Rate": str(sr)})


@app.post("/tts/voice-design")
def tts_voice_design(req: VoiceDesignRequest) -> Response:
    _require_ready(_VOICE_DESIGN)
    if req.language not in ("Chinese", "English", "Auto"):
        raise HTTPException(status_code=400, detail={"error": f"不支持的语言: {req.language}", "code": "unsupported_language", "engine": "voice_design"})
    try:
        with _inference(_VOICE_DESIGN):  # #23 并发 = 1
            if req.seed is not None:
                import torch

                torch.manual_seed(req.seed)
            wavs, sr = _VOICE_DESIGN.model.generate_voice_design(
                text=req.text.strip(), language=req.language, instruct=req.instruct.strip()
            )
        if not wavs:
            raise RuntimeError("模型未返回音频")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        if _looks_like_oom(e):
            _handle_oom(_VOICE_DESIGN, e)
            raise HTTPException(status_code=502, detail={"error": f"显存不足，模型已卸载，请重新预热后重试：{e}", "code": "resource_exhausted", "engine": "voice_design"})
        raise HTTPException(status_code=502, detail={"error": f"{type(e).__name__}: {e}", "code": "voice_design_failed", "engine": "voice_design"})
    return Response(content=_float_to_wav_bytes(wavs[0], sr), media_type="audio/wav", headers={"X-Sample-Rate": str(sr)})


@app.post("/tts/voice-clone")
def tts_voice_clone(
    file: UploadFile,
    text: str = Form(...),
    reference_text: str = Form(...),
    language: str = Form("Chinese"),
) -> Response:
    """用 Base checkpoint 的 ICL reference audio + transcript 生成一次克隆样音。

    同步端点（#23）：FastAPI 将其放入线程池执行，阻塞推理不再冻结事件循环（/health 永远可达）。
    """
    _require_ready(_VOICE_CLONE)
    if language not in ("Chinese", "English", "Auto"):
        raise HTTPException(status_code=400, detail={"error": f"不支持的语言: {language}", "code": "unsupported_language", "engine": "voice_clone"})
    if not text.strip() or not reference_text.strip():
        raise HTTPException(status_code=400, detail={"error": "测试文本和参考文本不能为空", "code": "invalid_request", "engine": "voice_clone"})
    audio_bytes = file.file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail={"error": "参考音频为空", "code": "invalid_request", "engine": "voice_clone"})
    try:
        import librosa

        speech, sample_rate = librosa.load(io.BytesIO(audio_bytes), sr=None, mono=True)
        if len(speech) == 0:
            raise ValueError("参考音频没有有效采样")
        with _inference(_VOICE_CLONE):  # #23 并发 = 1
            wavs, sr = _VOICE_CLONE.model.generate_voice_clone(
                text=text.strip(), language=language, ref_audio=(speech, sample_rate), ref_text=reference_text.strip()
            )
        if not wavs:
            raise RuntimeError("模型未返回音频")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        if _looks_like_oom(e):
            _handle_oom(_VOICE_CLONE, e)
            raise HTTPException(status_code=502, detail={"error": f"显存不足，模型已卸载，请重新预热后重试：{e}", "code": "resource_exhausted", "engine": "voice_clone"})
        raise HTTPException(status_code=502, detail={"error": f"{type(e).__name__}: {e}", "code": "voice_clone_failed", "engine": "voice_clone"})
    return Response(content=_float_to_wav_bytes(wavs[0], sr), media_type="audio/wav", headers={"X-Sample-Rate": str(sr)})


# ---------------------------------------------------------------------------
# ASR
# ---------------------------------------------------------------------------


@app.post("/asr/whisper")
def asr_whisper(file: UploadFile, language: str = Form("auto")) -> JSONResponse:
    """同步端点（#23）：阻塞推理放线程池，/health 与其他引擎不被冻结。"""
    _require_ready(_ASR)

    if language not in ("auto", "zh", "en"):
        raise HTTPException(status_code=400, detail={"error": f"不支持的语言: {language}", "code": "unsupported_language", "engine": "whisper_asr"})

    audio_bytes = file.file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail={"error": "音频文件为空", "code": "invalid_request", "engine": "whisper_asr"})

    try:
        import librosa
        import torch

        speech, _ = librosa.load(io.BytesIO(audio_bytes), sr=16000, mono=True)
        duration = len(speech) / 16000.0

        with _inference(_ASR):  # #23 Whisper 并发 = 1
            processor, model = _ASR.processor, _ASR.model
            device, dtype = _ASR.device, _ASR.dtype
            inputs = processor(speech, sampling_rate=16000, return_tensors="pt")
            input_features = inputs.input_features.to(device, dtype)

            gen_kwargs: dict[str, Any] = dict(task="transcribe")
            if duration > 30:
                gen_kwargs["return_timestamps"] = True
            if language != "auto":
                gen_kwargs["language"] = language

            with torch.no_grad():
                predicted_ids = model.generate(input_features, **gen_kwargs)
            text = processor.batch_decode(predicted_ids, skip_special_tokens=True)[0].strip()
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        if _looks_like_oom(e):
            _handle_oom(_ASR, e)
            raise HTTPException(status_code=502, detail={"error": f"显存不足，模型已卸载，请重新预热后重试：{e}", "code": "resource_exhausted", "engine": "whisper_asr"})
        raise HTTPException(status_code=502, detail={"error": f"{type(e).__name__}: {e}", "code": "asr_failed", "engine": "whisper_asr"})

    return JSONResponse({"success": True, "transcript": text, "language": language, "duration": round(duration, 2)})


# ---------------------------------------------------------------------------
# 目录 / 健康 / 预热 / 卸载
# ---------------------------------------------------------------------------


@app.get("/voices")
def voices() -> JSONResponse:
    # 不触发加载：未就绪如实 503（目录只有模型运行时才权威，硬性约束 #6）
    _require_ready(_TTS)
    return JSONResponse(
        {
            "checkpoint": _TTS.checkpoint,
            "speakers": _TTS.speakers,  # 官方精确 ID（下划线式，如 uncle_fu）
            "languages": _TTS.languages,
        }
    )


@app.get("/health")
def health() -> JSONResponse:
    # 永不触发加载：进程可达即 200，如实上报各引擎状态（available ≡ state == 'ready'）
    return JSONResponse(
        {
            "ok": True,
            "engines": {
                "qwen_tts": {**_snapshot(_TTS), "checkpoint": _TTS.checkpoint or TTS_CKPT},
                "voice_design": {**_snapshot(_VOICE_DESIGN), "checkpoint": _VOICE_DESIGN.checkpoint or VOICE_DESIGN_CKPT},
                "voice_clone": {**_snapshot(_VOICE_CLONE), "checkpoint": _VOICE_CLONE.checkpoint or VOICE_CLONE_CKPT},
                "whisper_asr": {**_snapshot(_ASR), "checkpoint": _ASR.checkpoint or ASR_MODEL_ID, "model": ASR_MODEL_ID},
            },
            # #21 进程级资源可见性：RSS/峰值 + 单常驻名单 + 空闲策略
            "process": {
                **_process_memory(),
                "idleUnloadSeconds": IDLE_UNLOAD_SECONDS,
                "residentBigEngines": [es.id for es in (_TTS, _VOICE_DESIGN, _VOICE_CLONE) if es.state == "ready"],
            },
        }
    )


def _warmup_response(es: EngineState) -> JSONResponse:
    with es.lock:
        state_before = es.state
        last_error = es.error

    if state_before == "ready":
        return JSONResponse({"engine": es.id, "state": "ready", "retry": False})

    _request_load(es)  # cold → 启动加载；loading → 幂等 no-op；error → 触发重载

    if state_before == "error":
        # 上一次加载失败：503 + retry=true（后台已重新开始加载，客户端稍后重试/轮询）
        return JSONResponse(
            status_code=503,
            content={"engine": es.id, "state": "loading", "error": last_error, "retry": True},
        )
    return JSONResponse(status_code=202, content={"engine": es.id, "state": "loading", "retry": True})


@app.post("/warmup/qwen")
def warmup_qwen() -> JSONResponse:
    return _warmup_response(_TTS)


@app.post("/warmup/voice-design")
def warmup_voice_design() -> JSONResponse:
    return _warmup_response(_VOICE_DESIGN)


@app.post("/warmup/voice-clone")
def warmup_voice_clone() -> JSONResponse:
    return _warmup_response(_VOICE_CLONE)


@app.post("/warmup/whisper")
def warmup_whisper() -> JSONResponse:
    return _warmup_response(_ASR)


@app.post("/unload/{segment}")
def unload(segment: str) -> JSONResponse:
    """#21 显式卸载：ready 且无在途推理 → 释放权重与显存、回到 cold（幂等）。"""
    engine_id = next((eid for eid, seg in _UNLOAD_PATH.items() if seg == segment), None)
    if engine_id is None:
        raise HTTPException(status_code=404, detail={"error": f"未知引擎路由: {segment}", "code": "unknown_engine"})
    es = _ENGINES_BY_ID(engine_id)

    if es.state == "loading":
        raise HTTPException(status_code=409, detail={"error": f"{engine_id} 正在加载，无法卸载", "code": "engine_loading", "engine": engine_id, "state": es.state})
    if es.in_flight > 0:
        raise HTTPException(status_code=409, detail={"error": f"{engine_id} 有在途推理，结束后再卸载", "code": "engine_busy", "engine": engine_id, "state": es.state})
    result = _unload_engine(es)
    if result != "cold":
        # 检查与卸载之间的窗口里开始了新推理：已登记延迟卸载（evict_pending），如实 409
        raise HTTPException(status_code=409, detail={"error": f"{engine_id} 刚开始新的推理，已登记延迟卸载", "code": "engine_busy", "engine": engine_id, "state": result})
    return JSONResponse({"engine": engine_id, "state": "cold", "retry": False})


def _ENGINES_BY_ID(engine_id: str) -> EngineState:
    """经模块全局取引擎（测试 monkeypatch 替换 _TTS 等引用后仍生效）"""
    return {"qwen_tts": _TTS, "voice_design": _VOICE_DESIGN, "voice_clone": _VOICE_CLONE, "whisper_asr": _ASR}[engine_id]

# -*- coding: utf-8 -*-
"""
Worker API 单元测试（P01 六：测试与 CI）

通过替换 worker.app._BUILDERS 注入伪模型——不下载任何真实权重，
覆盖引擎冷启动状态机与推理端点契约：

  - GET  /health       冷态永不触发加载（loadAttempts 恒 0）
  - POST /warmup/qwen  cold → 202 loading；loading 期间重复 warmup 幂等（不重复加载）；
                       ready → 200；error → 503 + retry 且自动重载
  - GET  /voices       未就绪如实 503 engine_not_ready
  - POST /tts/qwen     ready 后输出合法 RIFF/WAV；非官方 speaker 400；不支持语言 400
  - POST /asr/whisper  返回转录文本；空音频 400；不支持语言 400；长音频请求时间戳

模型生命周期与资源治理（P0-B #19-23，TestModelLifecycle）：

  - POST /unload/qwen  ready 且空闲 → 200 {state:"cold"} 载荷释放；在途推理 → 409 engine_busy
  - #22 折中方案       warmup 另一个大模型 → 既有常驻大模型被卸载；在途推理 → 延迟淘汰
  - #21 OOM            推理显存不足 → 载荷释放 + state=error（显式 warmup 才重载）
  - #21 空闲巡检       _sweep_idle_once 卸载超时闲置引擎；在途推理豁免
  - #19 能力合同       /health 每引擎自述 capabilities（语言来自运行时目录）
  - #20 模型身份       /health modelInfo 报本地权重指纹 / provider / 设备
  - #23 并发 = 1       /tts/qwen 并发请求被 infer_lock 串行化（max 并发 1）

torch / librosa 以轻量伪模块注入 sys.modules：这里测的是端点契约，
不依赖（也不下载）真实推理栈，CI 只需 requirements-base。
"""
import contextlib
import io
import sys
import threading
import time
import wave
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app as worker  # noqa: E402

OFFICIAL_SPEAKERS = ["aiden", "dylan", "eric", "ono_anna", "ryan", "serena", "sohee", "uncle_fu", "vivian"]
SMOKE_TEXT = "赛慕维，让企业人工智能从能回答走向能执行。"

client = TestClient(worker.app)


# ---------------- 伪模型（_BUILDERS 注入） ----------------


class FakeTtsModel:
    """generate_custom_voice 记录入参并返回 0.5s 24kHz 正弦波"""

    def __init__(self):
        self.calls: list[dict] = []

    def generate_custom_voice(self, text, language, speaker, instruct):
        self.calls.append({"text": text, "language": language, "speaker": speaker, "instruct": instruct})
        samples = np.arange(12000, dtype=np.float32)
        return [np.sin(samples * 0.05) * 0.5], 24000


class FakeVoiceDesignModel:
    def __init__(self):
        self.calls: list[dict] = []

    def generate_voice_design(self, text, language, instruct):
        self.calls.append({"text": text, "language": language, "instruct": instruct})
        return [np.zeros(2400, dtype=np.float32)], 24000


class FakeVoiceCloneModel:
    def __init__(self):
        self.calls: list[dict] = []

    def generate_voice_clone(self, text, language, ref_audio, ref_text, max_new_tokens=None):
        self.calls.append({"text": text, "language": language, "ref_audio_rate": ref_audio[1], "ref_audio_len": len(ref_audio[0]), "ref_text": ref_text, "max_new_tokens": max_new_tokens})
        return [np.zeros(2400, dtype=np.float32)], 24000


class FakeAsrProcessor:
    def __init__(self):
        self.speech_len = -1

    def __call__(self, speech, sampling_rate, return_tensors):
        assert sampling_rate == 16000
        self.speech_len = len(speech)
        return SimpleNamespace(input_features=SimpleNamespace(to=lambda device, dtype: "fake-features"))

    def batch_decode(self, predicted_ids, skip_special_tokens):
        assert skip_special_tokens is True
        return [" " + SMOKE_TEXT + " "]  # 两端带空格：验证服务端 strip


class FakeAsrModel:
    def __init__(self):
        self.calls: list[dict] = []

    def generate(self, input_features, **kwargs):
        assert input_features == "fake-features"
        self.calls.append(kwargs)
        return "fake-ids"


class FakeTorchModule:
    """ASR 端点只用到 no_grad 上下文"""

    @staticmethod
    def no_grad():
        return contextlib.nullcontext()


class FakeLibrosaModule:
    """librosa.load 伪实现：返回可配置时长的 16kHz 单声道"""

    duration_s = 1.0
    clone_signal = None  # /tts/voice-clone 走 sr=None 分支：静音压缩测试注入真实波形

    @staticmethod
    def load(buf, sr, mono):
        assert mono is True
        if sr is None:
            if FakeLibrosaModule.clone_signal is not None:
                return FakeLibrosaModule.clone_signal, 24000
            return np.zeros(24000, dtype=np.float32), 24000
        assert sr == 16000
        return np.zeros(int(16000 * FakeLibrosaModule.duration_s), dtype=np.float32), 16000


def tts_payload() -> dict:
    return {
        "model": FakeTtsModel(),
        "speakers": list(OFFICIAL_SPEAKERS),
        "languages": ["Auto", "Chinese", "English"],
        "device": "cpu",
        "checkpoint": "fake-ckpt",
    }


def asr_payload() -> dict:
    return {"model": FakeAsrModel(), "processor": FakeAsrProcessor(), "device": "cpu", "dtype": "float32"}


def test_voice_design_uses_its_own_model_and_outputs_wav(monkeypatch):
    design = worker.EngineState(id="voice_design")
    model = FakeVoiceDesignModel()
    monkeypatch.setattr(worker, "_VOICE_DESIGN", design)
    monkeypatch.setitem(worker._BUILDERS, "voice_design", lambda: {"model": model, "device": "cpu", "checkpoint": "fake-voice-design"})

    request = {"text": "统一参考文本", "instruct": "专业可信、自然克制", "language": "Chinese"}
    cold = client.post("/tts/voice-design", json=request)
    assert cold.status_code == 503
    assert cold.json()["detail"]["engine"] == "voice_design"

    warmup = client.post("/warmup/voice-design")
    assert warmup.status_code == 202
    wait_for_state(design, "ready")
    result = client.post("/tts/voice-design", json=request)
    assert result.status_code == 200
    assert result.content[:4] == b"RIFF"
    assert model.calls == [request]
    assert client.get("/health").json()["engines"]["voice_design"]["state"] == "ready"


def test_voice_clone_uses_base_engine_and_requires_reference_audio(monkeypatch):
    clone = worker.EngineState(id="voice_clone")
    model = FakeVoiceCloneModel()
    monkeypatch.setattr(worker, "_VOICE_CLONE", clone)
    monkeypatch.setitem(worker._BUILDERS, "voice_clone", lambda: {"model": model, "device": "cpu", "checkpoint": "fake-base"})
    monkeypatch.setitem(sys.modules, "librosa", FakeLibrosaModule)

    cold = client.post("/tts/voice-clone", files=wav_form(), data={"text": "测试文本", "reference_text": "参考文本", "language": "Chinese"})
    assert cold.status_code == 503
    assert cold.json()["detail"]["engine"] == "voice_clone"

    assert client.post("/warmup/voice-clone").status_code == 202
    wait_for_state(clone, "ready")
    result = client.post("/tts/voice-clone", files=wav_form(), data={"text": "测试文本", "reference_text": "参考文本", "language": "Chinese"})
    assert result.status_code == 200
    assert result.content[:4] == b"RIFF"
    assert model.calls == [{"text": "测试文本", "language": "Chinese", "ref_audio_rate": 24000, "ref_audio_len": 24000, "ref_text": "参考文本", "max_new_tokens": 480}]


def test_voice_clone_compresses_reference_silence_before_inference(monkeypatch):
    """静音占比高的参考音频先压缩再进模型：23s 现场录音里 ~19s 静音会被 ICL 学进语速"""
    clone = worker.EngineState(id="voice_clone")
    model = FakeVoiceCloneModel()
    monkeypatch.setattr(worker, "_VOICE_CLONE", clone)
    monkeypatch.setitem(worker._BUILDERS, "voice_clone", lambda: {"model": model, "device": "cpu", "checkpoint": "fake-base"})
    monkeypatch.setitem(sys.modules, "librosa", FakeLibrosaModule)

    sr = 24000

    def tone(secs: float) -> np.ndarray:
        return (np.sin(np.arange(int(sr * secs)) * 0.05) * 0.5).astype(np.float32)

    # 3s 静音 + 1s 语音 + 3s 静音 + 1s 语音 + 5s 静音 = 13s，有效语音只有 2s
    monkeypatch.setattr(
        FakeLibrosaModule,
        "clone_signal",
        np.concatenate([np.zeros(3 * sr, dtype=np.float32), tone(1.0), np.zeros(3 * sr, dtype=np.float32), tone(1.0), np.zeros(5 * sr, dtype=np.float32)]),
    )

    assert client.post("/warmup/voice-clone").status_code == 202
    wait_for_state(clone, "ready")
    result = client.post("/tts/voice-clone", files=wav_form(), data={"text": "测试文本", "reference_text": "参考文本", "language": "Chinese"})
    assert result.status_code == 200
    kept = model.calls[0]["ref_audio_len"]
    assert int(2.0 * sr) < kept < int(3.0 * sr)  # 13s → ~2.6s：首尾静音剪掉、段间 3s 静音压到 0.3s


class GatedBuilder:
    """release() 前一直停在 loading，用于断言 loading 期间的幂等性"""

    def __init__(self):
        self._gate = threading.Event()
        self.calls = 0

    def __call__(self):
        self.calls += 1
        assert self._gate.wait(timeout=10), "测试未调用 release()"
        return tts_payload()

    def release(self):
        self._gate.set()


# ---------------- 夹具与工具 ----------------


@pytest.fixture()
def engines(monkeypatch):
    """每个用例全新的 EngineState（monkeypatch 自动还原全局引用，后台线程绝不跨用例泄漏状态）"""
    tts = worker.EngineState(id="qwen_tts")
    asr = worker.EngineState(id="whisper_asr")
    monkeypatch.setattr(worker, "_TTS", tts)
    monkeypatch.setattr(worker, "_ASR", asr)
    return SimpleNamespace(tts=tts, asr=asr)


def wait_for_state(es: worker.EngineState, state: str, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if es.state == state:
            return
        time.sleep(0.01)
    raise AssertionError(f"{es.id} 未在 {timeout}s 内进入 {state}（当前 {es.state}: {es.error}）")


def warmup_until_ready(monkeypatch, engines, engine: str = "qwen_tts") -> dict:
    payload = tts_payload() if engine == "qwen_tts" else asr_payload()
    monkeypatch.setitem(worker._BUILDERS, engine, lambda: payload)
    r = client.post(f"/warmup/{worker._WARMUP_PATH[engine]}")
    assert r.status_code == 202
    es = engines.tts if engine == "qwen_tts" else engines.asr
    wait_for_state(es, "ready")
    return payload


def wav_form() -> dict:
    """任意非空 WAV 字节即可（ASR 处理栈已被伪模块替换）"""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * 160)
    return {"file": ("a.wav", buf.getvalue(), "audio/wav")}


# ---------------- 状态机 ----------------


class TestEngineStateMachine:
    def test_health_cold_never_loads(self, engines, monkeypatch):
        def must_not_load():
            raise AssertionError("健康检查绝不能触发模型加载")

        monkeypatch.setitem(worker._BUILDERS, "qwen_tts", must_not_load)
        monkeypatch.setitem(worker._BUILDERS, "whisper_asr", must_not_load)

        r = client.get("/health")
        assert r.status_code == 200
        engines_json = r.json()["engines"]
        for engine_id in ("qwen_tts", "whisper_asr"):
            snap = engines_json[engine_id]
            assert snap["state"] == "cold"
            assert snap["available"] is False
            assert snap["loadAttempts"] == 0

        # 目录端点同样不触发加载：未就绪如实 503
        r2 = client.get("/voices")
        assert r2.status_code == 503
        assert r2.json()["detail"]["code"] == "engine_not_ready"
        assert engines.tts.state == "cold"

    def test_warmup_cold_returns_202_and_no_duplicate_load(self, engines, monkeypatch):
        gate = GatedBuilder()
        monkeypatch.setitem(worker._BUILDERS, "qwen_tts", gate)

        r = client.post("/warmup/qwen")
        assert r.status_code == 202
        assert r.json() == {"engine": "qwen_tts", "state": "loading", "retry": True}
        assert engines.tts.state == "loading"
        assert engines.tts.load_attempts == 1

        # loading 期间反复 warmup：幂等，绝不重复加载
        for _ in range(3):
            assert client.post("/warmup/qwen").status_code == 202
        assert engines.tts.load_attempts == 1
        assert gate.calls == 1

        gate.release()
        wait_for_state(engines.tts, "ready")
        assert engines.tts.load_attempts == 1

    def test_warmup_ready_returns_200(self, engines, monkeypatch):
        monkeypatch.setitem(worker._BUILDERS, "qwen_tts", lambda: tts_payload())
        assert client.post("/warmup/qwen").status_code == 202
        wait_for_state(engines.tts, "ready")

        r = client.post("/warmup/qwen")
        assert r.status_code == 200
        assert r.json() == {"engine": "qwen_tts", "state": "ready", "retry": False}
        assert engines.tts.load_attempts == 1  # ready 后 warmup 不再加载

        snap = client.get("/health").json()["engines"]["qwen_tts"]
        assert snap["available"] is True
        assert snap["error"] is None

    def test_error_state_surfaces_real_cause(self, engines, monkeypatch):
        def boom():
            raise RuntimeError("checkpoint 目录不存在")

        monkeypatch.setitem(worker._BUILDERS, "qwen_tts", boom)
        client.post("/warmup/qwen")
        wait_for_state(engines.tts, "error")

        snap = client.get("/health").json()["engines"]["qwen_tts"]
        assert snap["state"] == "error"
        assert snap["available"] is False
        assert "RuntimeError" in snap["error"]
        assert "checkpoint 目录不存在" in snap["error"]

        # 未就绪端点如实 503，错误信息带真实原因（不伪造成功）
        r = client.post("/tts/qwen", json={"text": SMOKE_TEXT, "speaker": "uncle_fu"})
        assert r.status_code == 503
        detail = r.json()["detail"]
        assert detail["code"] == "engine_not_ready"
        assert detail["state"] == "error"
        assert "checkpoint 目录不存在" in detail["error"]

    def test_error_warmup_retries_load(self, engines, monkeypatch):
        remaining = {"failures": 1}

        def flaky():
            if remaining["failures"]:
                remaining["failures"] -= 1
                raise OSError("显存不足")
            return tts_payload()

        monkeypatch.setitem(worker._BUILDERS, "qwen_tts", flaky)
        client.post("/warmup/qwen")
        wait_for_state(engines.tts, "error")

        # error → warmup：503 + retry:true，且后台已自动重新加载
        r = client.post("/warmup/qwen")
        assert r.status_code == 503
        body = r.json()
        assert body["state"] == "loading"
        assert body["retry"] is True
        assert "显存不足" in body["error"]
        assert engines.tts.load_attempts == 2

        wait_for_state(engines.tts, "ready")
        assert remaining["failures"] == 0


# ---------------- TTS 端点 ----------------


class TestTtsEndpoint:
    def test_returns_valid_riiff_wav(self, engines, monkeypatch):
        payload = warmup_until_ready(monkeypatch, engines)
        model = payload["model"]

        r = client.post("/tts/qwen", json={"text": SMOKE_TEXT, "speaker": "uncle_fu"})
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("audio/wav")
        assert r.headers["x-sample-rate"] == "24000"

        raw = r.content
        assert raw[:4] == b"RIFF" and raw[8:12] == b"WAVE"  # 真实 WAV 字节，不是占位数据
        with wave.open(io.BytesIO(raw)) as w:
            assert w.getnchannels() == 1
            assert w.getsampwidth() == 2  # 16-bit PCM
            assert w.getframerate() == 24000
            assert w.getnframes() == 12000  # 0.5s

        # 请求参数如实传给模型（speaker 精确 ID 原样到达）
        assert model.calls == [
            {"text": SMOKE_TEXT, "language": "Auto", "speaker": "uncle_fu", "instruct": None}
        ]

    def test_rejects_non_official_speaker(self, engines, monkeypatch):
        payload = warmup_until_ready(monkeypatch, engines)
        # 硬性约束 #5/#6：Google Voice ID、展示名、错误大小写一律拒绝
        for bad in ("Kore", "Uncle Fu", "Uncle_Fu", "陈叔叔"):
            r = client.post("/tts/qwen", json={"text": SMOKE_TEXT, "speaker": bad})
            assert r.status_code == 400, bad
            detail = r.json()["detail"]
            assert detail["code"] == "unsupported_speaker"
            assert detail["speakers"] == OFFICIAL_SPEAKERS
        assert payload["model"].calls == []  # 校验先于推理

    def test_rejects_unsupported_language(self, engines, monkeypatch):
        warmup_until_ready(monkeypatch, engines)
        r = client.post("/tts/qwen", json={"text": SMOKE_TEXT, "speaker": "uncle_fu", "language": "French"})
        assert r.status_code == 400
        detail = r.json()["detail"]
        assert detail["code"] == "unsupported_language"
        assert detail["languages"] == ["Auto", "Chinese", "English"]

    def test_normalizes_language_to_runtime_catalog_casing(self, engines, monkeypatch):
        payload = warmup_until_ready(monkeypatch, engines)
        engines.tts.languages = ["auto", "chinese", "english"]
        r = client.post("/tts/qwen", json={"text": SMOKE_TEXT, "speaker": "uncle_fu", "language": "Chinese"})
        assert r.status_code == 200
        assert payload["model"].calls[-1]["language"] == "chinese"


# ---------------- ASR 端点 ----------------


class TestAsrEndpoint:
    @pytest.fixture(autouse=True)
    def _fake_inference_stack(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "torch", FakeTorchModule)
        monkeypatch.setitem(sys.modules, "librosa", FakeLibrosaModule)
        monkeypatch.setattr(FakeLibrosaModule, "duration_s", 1.0)

    def test_returns_transcript(self, engines, monkeypatch):
        payload = warmup_until_ready(monkeypatch, engines, engine="whisper_asr")

        r = client.post("/asr/whisper", files=wav_form(), data={"language": "zh"})
        assert r.status_code == 200
        body = r.json()
        assert body["success"] is True
        assert body["transcript"] == SMOKE_TEXT  # 服务端已 strip
        assert body["language"] == "zh"
        assert body["duration"] == 1.0
        # 推理参数如实传递：指定语言、短音频不加时间戳
        assert payload["model"].calls == [{"task": "transcribe", "language": "zh"}]
        assert payload["processor"].speech_len == 16000

    def test_long_audio_requests_timestamps(self, engines, monkeypatch):
        monkeypatch.setattr(FakeLibrosaModule, "duration_s", 31.0)
        payload = warmup_until_ready(monkeypatch, engines, engine="whisper_asr")

        r = client.post("/asr/whisper", files=wav_form(), data={"language": "auto"})
        assert r.status_code == 200
        assert payload["model"].calls[0] == {"task": "transcribe", "return_timestamps": True}

    def test_empty_audio_rejected(self, engines, monkeypatch):
        warmup_until_ready(monkeypatch, engines, engine="whisper_asr")
        r = client.post("/asr/whisper", files={"file": ("a.wav", b"", "audio/wav")}, data={"language": "auto"})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "invalid_request"

    def test_unsupported_language_rejected(self, engines, monkeypatch):
        warmup_until_ready(monkeypatch, engines, engine="whisper_asr")
        r = client.post("/asr/whisper", files=wav_form(), data={"language": "fr"})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "unsupported_language"

    def test_not_ready_returns_503(self, engines):
        r = client.post("/asr/whisper", files=wav_form(), data={"language": "auto"})
        assert r.status_code == 503
        assert r.json()["detail"]["code"] == "engine_not_ready"


# ---------------- 模型生命周期与资源治理（P0-B #19-23） ----------------


@pytest.fixture()
def big_engines(monkeypatch):
    """全新的大模型引擎三件套（#22 单常驻约束的测试隔离）"""
    states = SimpleNamespace(
        tts=worker.EngineState(id="qwen_tts"),
        design=worker.EngineState(id="voice_design"),
        clone=worker.EngineState(id="voice_clone"),
    )
    monkeypatch.setattr(worker, "_TTS", states.tts)
    monkeypatch.setattr(worker, "_VOICE_DESIGN", states.design)
    monkeypatch.setattr(worker, "_VOICE_CLONE", states.clone)
    return states


def warm_big_engine(monkeypatch, es: worker.EngineState, payload: dict) -> None:
    monkeypatch.setitem(worker._BUILDERS, es.id, lambda: payload)
    assert client.post(f"/warmup/{worker._WARMUP_PATH[es.id]}").status_code == 202
    wait_for_state(es, "ready")


class TestModelLifecycle:
    def test_unload_releases_payload_and_returns_cold(self, big_engines, monkeypatch):
        payload = tts_payload()
        warm_big_engine(monkeypatch, big_engines.tts, payload)
        assert big_engines.tts.state == "ready"

        r = client.post("/unload/qwen")
        assert r.status_code == 200
        assert r.json() == {"engine": "qwen_tts", "state": "cold", "retry": False}
        assert big_engines.tts.state == "cold"
        assert big_engines.tts.model is None  # 载荷已释放，不是只改状态
        assert big_engines.tts.loaded_at is None
        assert big_engines.tts.last_used_at is None
        # 冷引擎幂等：再次卸载仍是 200 cold
        assert client.post("/unload/qwen").json()["state"] == "cold"
        # 卸载后推理如实 503
        assert client.post("/tts/qwen", json={"text": SMOKE_TEXT, "speaker": "uncle_fu"}).status_code == 503

    def test_unload_refuses_loading_and_busy_engines(self, big_engines, monkeypatch):
        warm_big_engine(monkeypatch, big_engines.tts, tts_payload())
        big_engines.tts.state = "loading"  # 白盒：占住 loading 态
        r = client.post("/unload/qwen")
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "engine_loading"
        big_engines.tts.state = "ready"

        big_engines.tts.in_flight = 1  # 白盒：模拟在途推理（真实由 _inference 记账）
        r = client.post("/unload/qwen")
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "engine_busy"
        assert big_engines.tts.state == "ready"  # 未被卸载
        big_engines.tts.in_flight = 0

    def test_warming_other_big_engine_unloads_resident(self, big_engines, monkeypatch):
        """#22 折中方案：warmup voice_design 时，常驻的 qwen_tts 被显式卸载"""
        warm_big_engine(monkeypatch, big_engines.tts, tts_payload())
        warm_big_engine(
            monkeypatch,
            big_engines.design,
            {"model": FakeVoiceDesignModel(), "device": "cpu", "checkpoint": "fake-voice-design"},
        )
        assert big_engines.design.state == "ready"
        wait_for_state(big_engines.tts, "cold")  # 切换 = 卸载既有常驻者

    def test_busy_resident_is_evicted_after_inference(self, big_engines, monkeypatch):
        """#22 在途推理不被强拆：标记 evict_pending，推理结束后后台卸载"""
        warm_big_engine(monkeypatch, big_engines.tts, tts_payload())
        with worker._inference(big_engines.tts):
            assert big_engines.tts.in_flight == 1
            worker._evict_other_big_engines("voice_design")  # 模拟切换方触发的驱逐
            assert big_engines.tts.evict_pending is True
            assert big_engines.tts.state == "ready"  # 推理期间绝不卸载
        wait_for_state(big_engines.tts, "cold")  # _inference 退出后延迟卸载
        assert big_engines.tts.evict_pending is False

    def test_oom_releases_payload_and_marks_error(self, big_engines, monkeypatch):
        """#21/#23：推理 OOM → 释放载荷 + state=error；恢复只能显式 warmup（无自动重启循环）"""

        class OomModel:
            def generate_custom_voice(self, text, language, speaker, instruct):
                raise MemoryError("MPS backend out of memory: try to allocate 2.0 GiB")

        warm_big_engine(monkeypatch, big_engines.tts, {**tts_payload(), "model": OomModel()})
        r = client.post("/tts/qwen", json={"text": SMOKE_TEXT, "speaker": "uncle_fu"})
        assert r.status_code == 502
        assert r.json()["detail"]["code"] == "resource_exhausted"
        wait_for_state(big_engines.tts, "error")
        assert big_engines.tts.model is None  # 资源已清理
        assert "显存不足" in big_engines.tts.error
        # 未就绪端点如实 503（error 态，不自动重载）
        assert client.post("/tts/qwen", json={"text": SMOKE_TEXT, "speaker": "uncle_fu"}).status_code == 503

    def test_sweep_idle_once_unloads_stale_engine(self, big_engines, monkeypatch):
        """#21 空闲巡检：超阈值未使用 → 卸载；在途推理豁免；阈值 0 关闭"""
        monkeypatch.setattr(worker, "IDLE_UNLOAD_SECONDS", 60.0)
        warm_big_engine(monkeypatch, big_engines.tts, tts_payload())

        big_engines.tts.in_flight = 1
        assert worker._sweep_idle_once() == []  # 在途推理豁免
        big_engines.tts.in_flight = 0

        assert worker._sweep_idle_once() == []  # 刚就绪未超时（last_used/loaded 是现在）
        big_engines.tts.last_used_at = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        assert worker._sweep_idle_once() == ["qwen_tts"]
        assert big_engines.tts.state == "cold"

    def test_health_reports_capabilities_contract(self, big_engines, monkeypatch):
        """#19 能力合同：模型自述能力，qwen_tts 语言来自运行时目录（不是写死枚举）"""
        warm_big_engine(monkeypatch, big_engines.tts, tts_payload())
        engines_json = client.get("/health").json()["engines"]

        tts_caps = engines_json["qwen_tts"]["capabilities"]
        assert tts_caps["presetVoice"] is True
        assert tts_caps["clone"] is False
        assert tts_caps["transcription"] is False
        assert tts_caps["languages"] == ["Auto", "Chinese", "English"]  # tts_payload 运行时目录
        assert tts_caps["supportsReferenceAudio"] is False

        clone_caps = engines_json["voice_clone"]["capabilities"]  # 冷引擎也有静态能力合同
        assert clone_caps["clone"] is True
        assert clone_caps["supportsReferenceAudio"] is True
        asr_caps = engines_json["whisper_asr"]["capabilities"]
        assert asr_caps["transcription"] is True
        assert asr_caps["presetVoice"] is False

    def test_health_reports_model_identity_fingerprint(self, big_engines, monkeypatch, tmp_path):
        """#20 模型身份：本地目录 → 权重指纹（内容变化 → 指纹变化）；provider/设备如实上报"""
        model_dir = tmp_path / "Qwen3-TTS-CustomVoice"
        model_dir.mkdir()
        (model_dir / "config.json").write_text('{"model_type": "qwen3_tts"}', encoding="utf-8")
        (model_dir / "model.safetensors").write_bytes(b"\x00" * 1024)

        payload = {**tts_payload(), "checkpoint": str(model_dir)}
        warm_big_engine(monkeypatch, big_engines.tts, payload)
        info = client.get("/health").json()["engines"]["qwen_tts"]["modelInfo"]
        assert info["localPath"] == str(model_dir)
        assert info["repoId"] == str(model_dir)
        assert info["provider"] == "Qwen"
        fingerprint = info["localPathFingerprint"]
        assert fingerprint and len(fingerprint) == 16

        (model_dir / "config.json").write_text('{"model_type": "qwen3_tts_v2"}', encoding="utf-8")
        assert worker._fingerprint_dir(model_dir) != fingerprint  # 静默升级可被检测

        asr_info = client.get("/health").json()["engines"]["whisper_asr"]["modelInfo"]
        assert asr_info["provider"] == "OpenAI"  # 冷引擎也上报目标 checkpoint 身份
        assert asr_info["localPathFingerprint"] is None

    def test_tts_qwen_serializes_concurrent_inference(self, big_engines, monkeypatch):
        """#23 每引擎并发 = 1：两个并发请求被 infer_lock 串行化，inFlight 收敛回 0"""

        class CountingModel:
            def __init__(self):
                self._guard = threading.Lock()
                self.active = 0
                self.max_active = 0

            def generate_custom_voice(self, text, language, speaker, instruct):
                with self._guard:
                    self.active += 1
                    self.max_active = max(self.max_active, self.active)
                time.sleep(0.15)
                with self._guard:
                    self.active -= 1
                return [np.zeros(2400, dtype=np.float32)], 24000

        model = CountingModel()
        warm_big_engine(monkeypatch, big_engines.tts, {**tts_payload(), "model": model})

        results: list = []

        def post():
            results.append(client.post("/tts/qwen", json={"text": SMOKE_TEXT, "speaker": "uncle_fu"}))

        threads = [threading.Thread(target=post) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)
        assert all(r.status_code == 200 for r in results)
        assert model.max_active == 1  # 绝不并行进入推理
        assert client.get("/health").json()["engines"]["qwen_tts"]["inFlight"] == 0


# ---------------- 模型下载任务（P1 #32，协议 3） ----------------


class TestModelDownload:
    """POST /models/{key}/download 的任务合同：camelCase 形状、同 key 幂等复用、
    不同目标 409、协作取消（_cancel 标志 → 进度回调抛出中断）、/health 协议版本 3。

    线程体被 monkeypatch 替换——不触发任何真实 snapshot_download / 网络。
    """

    SHA = "5d41402abc4b2a76b9719d911017c592"

    @pytest.fixture(autouse=True)
    def reset_tasks(self, monkeypatch):
        monkeypatch.setattr(worker, "_MODEL_TASKS", {})
        monkeypatch.setattr(worker, "_MODEL_ACTIVE_BY_KEY", {})

    def _stub_run(self, monkeypatch, started: threading.Event, release: threading.Event):
        """线程替身：标记启动后挂起；放行时按 _cancel 收敛为 cancelled/completed"""

        def fake_run(task_id: str, repo_id: str, revision) -> None:
            started.set()
            release.wait(timeout=10)
            try:
                with worker._MODEL_TASK_LOCK:
                    task = worker._MODEL_TASKS.get(task_id)
                    if task is not None:
                        task["state"] = "cancelled" if task.get("_cancel") else "completed"
                        task["revision"] = self.SHA
                        task["updatedAt"] = worker._now_iso()
            finally:
                # 与真实线程体一致的收尾：终态释放 key 占位
                with worker._MODEL_TASK_LOCK:
                    task = worker._MODEL_TASKS.get(task_id)
                    key = task["key"] if task is not None else None
                    if key and worker._MODEL_ACTIVE_BY_KEY.get(key) == task_id:
                        del worker._MODEL_ACTIVE_BY_KEY[key]

        monkeypatch.setattr(worker, "_run_model_download", fake_run)

    def test_health_reports_protocol_3(self):
        r = client.get("/health")
        assert r.status_code == 200
        assert r.json()["protocolVersion"] == 3

    def test_unknown_key_rejected(self):
        r = client.post("/models/nope/download", json={"repoId": "x/y"})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "unknown_model"

    def test_download_task_shape_and_lifecycle(self, monkeypatch):
        started, release = threading.Event(), threading.Event()
        self._stub_run(monkeypatch, started, release)

        r = client.post("/models/customVoice/download", json={"repoId": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"})
        assert r.status_code == 200
        task = r.json()["task"]
        assert task["key"] == "customVoice"
        assert task["repoId"] == "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
        assert task["requestedRevision"] is None
        assert task["state"] == "downloading"
        assert "_cancel" not in task  # 内部下划线键绝不下发
        assert started.wait(timeout=5)

        release.set()
        for _ in range(200):  # 线程收敛后再查
            if client.get(f"/models/tasks/{task['taskId']}").json()["task"]["state"] == "completed":
                break
            time.sleep(0.01)
        final = client.get(f"/models/tasks/{task['taskId']}").json()["task"]
        assert final["state"] == "completed"
        assert final["revision"] == self.SHA

        assert client.get("/models/tasks/mdl-missing").status_code == 404

    def test_same_key_idempotent_reuse_and_conflict(self, monkeypatch):
        started, release = threading.Event(), threading.Event()
        self._stub_run(monkeypatch, started, release)

        first = client.post("/models/asr/download", json={"repoId": "openai/whisper-large-v3-turbo"}).json()["task"]
        assert started.wait(timeout=5)

        # 同 repo 同 revision → 幂等复用在途任务
        again = client.post("/models/asr/download", json={"repoId": "openai/whisper-large-v3-turbo"})
        assert again.status_code == 200
        assert again.json()["task"]["taskId"] == first["taskId"]

        # 同 key 不同目标 → 409（不悄悄换目标）
        conflict = client.post("/models/asr/download", json={"repoId": "openai/whisper-large-v3-turbo", "revision": "v1"})
        assert conflict.status_code == 409
        assert conflict.json()["detail"]["code"] == "model_task_conflict"

        release.set()

    def test_cancel_is_cooperative_flag(self, monkeypatch):
        started, release = threading.Event(), threading.Event()
        self._stub_run(monkeypatch, started, release)

        task = client.post("/models/base/download", json={"repoId": "Qwen/Qwen3-TTS-12Hz-1.7B-Base"}).json()["task"]
        assert started.wait(timeout=5)

        r = client.post(f"/models/tasks/{task['taskId']}/cancel")
        assert r.status_code == 202
        with worker._MODEL_TASK_LOCK:
            assert worker._MODEL_TASKS[task["taskId"]]["_cancel"] is True
        assert worker._MODEL_ACTIVE_BY_KEY.get("base") == task["taskId"]  # 结束前仍占位

        release.set()
        for _ in range(200):
            with worker._MODEL_TASK_LOCK:
                if worker._MODEL_TASKS[task["taskId"]]["state"] == "cancelled":
                    break
            time.sleep(0.01)
        with worker._MODEL_TASK_LOCK:
            assert worker._MODEL_TASKS[task["taskId"]]["state"] == "cancelled"
        assert "base" not in worker._MODEL_ACTIVE_BY_KEY  # 终态释放 key 占位

    def test_task_progress_feeds_bytes_and_raises_on_cancel(self):
        """_TaskProgress：逐文件字节进任务记账；_cancel 置位后下个回调抛 _ModelDownloadCancelled"""
        task = {"taskId": "t-x", "key": "asr", "downloadedBytes": 0, "_cancel": False}
        worker._MODEL_TASKS["t-x"] = task
        progress = worker._TaskProgress(task)
        with progress:
            progress.update(100)
            progress.update(50)
            assert task["downloadedBytes"] == 150

            task["_cancel"] = True
            with pytest.raises(worker._ModelDownloadCancelled):
                progress.update(1)

        del worker._MODEL_TASKS["t-x"]
        progress.update(10)  # 任务已被清理：静默停记（既不抛错也不累计）
        assert task["downloadedBytes"] == 151


# ---------------- 克隆参考静音压缩 ----------------


def _tone(secs: float, sr: int, amp: float = 0.5) -> np.ndarray:
    return (np.sin(np.arange(int(sr * secs)) * 0.05) * amp).astype(np.float32)


def _longest_silent_run(arr: np.ndarray, floor: float = 0.01) -> int:
    silent = (np.abs(arr) < floor).astype(np.int8)
    padded = np.concatenate(([0], silent, [0]))
    bounds = np.flatnonzero(np.diff(padded))
    return max((bounds[i + 1] - bounds[i] for i in range(0, bounds.size, 2)), default=0)


class TestCompressReferenceSilence:
    """worker._compress_reference_silence：首尾静音裁掉、内部长停顿压到 keep_pause_s、
    纯 numpy 不依赖 librosa；压缩结果不足 1s / 全静音 / 过短输入一律原样返回。"""

    def test_trims_edges_and_caps_internal_pauses(self):
        sr = 16000
        speech = np.concatenate(
            [np.zeros(2 * sr, dtype=np.float32), _tone(1, sr), np.zeros(3 * sr, dtype=np.float32), _tone(1, sr), np.zeros(4 * sr, dtype=np.float32)]
        )
        out = worker._compress_reference_silence(speech, sr)
        assert out is not speech
        assert 2.3 < out.size / sr < 2.95  # 2s 语音 + 0.3s 停顿（帧对齐有余量）
        # 压缩后最长停顿 ≈ 0.3s 内容 + 两侧 keep 段各 ≤1 帧的过冲（0.3s + 2×2048/16k ≈ 0.56s）
        assert _longest_silent_run(out) < int(0.6 * sr)
        # 首尾紧贴有效语音（帧网格允许 ≤1 帧的引导/拖尾静音）
        assert float(np.sqrt(np.mean(np.square(out[:2500])))) > 0.1
        assert float(np.sqrt(np.mean(np.square(out[-2500:])))) > 0.1

    def test_natural_pauses_and_clean_edges_untouched(self):
        sr = 16000
        speech = np.concatenate([_tone(3, sr), np.zeros(int(0.5 * sr), dtype=np.float32), _tone(3, sr)])
        out = worker._compress_reference_silence(speech, sr)
        # 无首尾静音、停顿 ≤ max_pause_s：最多丢帧网格盖不住的尾部（< hop=512）
        assert speech.size - 512 <= out.size <= speech.size

    def test_compress_result_under_1s_returns_original(self):
        sr = 16000
        speech = np.concatenate([_tone(0.1, sr), np.zeros(2 * sr, dtype=np.float32)])
        assert worker._compress_reference_silence(speech, sr) is speech

    def test_silent_or_tiny_input_passthrough(self):
        sr = 16000
        silent = np.zeros(3 * sr, dtype=np.float32)
        assert worker._compress_reference_silence(silent, sr) is silent  # 全静音：peak=0 原样返回
        tiny = np.zeros(1000, dtype=np.float32)
        assert worker._compress_reference_silence(tiny, sr) is tiny  # 短于两帧：不处理

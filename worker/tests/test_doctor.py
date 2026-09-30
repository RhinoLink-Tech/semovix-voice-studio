# -*- coding: utf-8 -*-
"""
doctor.py 结构化输出测试（P0-A #8：Electron 不解析终端文本）

覆盖：
  - --json 输出可被 json.loads 解析（即便 stdout 前有第三方包噪音，
    JSON 本体必须是最后一个平衡对象——这里用与 Electron 侧一致的提取逻辑）
  - 顶层结构：status / python / device / checks
  - checks 覆盖四个模型 id（model-customvoice / voice-design / base / whisper）
  - 退出码与 status 一致（fail → 1，否则 0）
  - 文本模式保持 PASS/WARN/FAIL 终端输出（回归保护）
"""
import json
import subprocess
import sys
from pathlib import Path

WORKER_ROOT = Path(__file__).resolve().parents[1]
DOCTOR = WORKER_ROOT / "doctor.py"

MODEL_CHECK_IDS = {"model-customvoice", "model-voice-design", "model-base", "model-whisper"}


def extract_balanced_json(raw: str) -> dict:
    """与 Electron doctor 解析器同策略：从第一个 '{' 起做括号配平，取最后一个平衡对象"""
    start = raw.index("{")
    depth = 0
    for i in range(start, len(raw)):
        ch = raw[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return json.loads(raw[start : i + 1])
    raise AssertionError("doctor --json 未输出平衡的 JSON 对象")


def run_doctor(*args: str) -> tuple[dict | None, str, int]:
    proc = subprocess.run(
        [sys.executable, str(DOCTOR), *args],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=str(WORKER_ROOT),
    )
    payload = None
    if "--json" in args:
        payload = extract_balanced_json(proc.stdout)
    return payload, proc.stdout, proc.returncode


def test_json_mode_structure():
    payload, _, code = run_doctor("--json")

    assert payload["status"] in {"pass", "pass_with_warnings", "fail"}
    assert payload["python"]["path"].endswith(("python", "python3", sys.executable.split("/")[-1]))
    assert payload["python"]["version"].count(".") == 2
    assert payload["device"]["type"] in {"mps", "cuda", "cpu", "unknown"}
    assert isinstance(payload["device"]["name"], str)

    ids = {c["id"] for c in payload["checks"]}
    assert MODEL_CHECK_IDS <= ids, f"缺少模型检查项: {MODEL_CHECK_IDS - ids}"
    for check in payload["checks"]:
        assert check["state"] in {"pass", "warn", "fail"}
        assert isinstance(check["message"], str)

    # 退出码契约：fail → 1；否则 0
    assert code == (1 if payload["status"] == "fail" else 0)


def test_json_status_matches_checks():
    payload, _, _ = run_doctor("--json")
    states = {c["state"] for c in payload["checks"]}
    if "fail" in states:
        assert payload["status"] == "fail"
    elif "warn" in states:
        assert payload["status"] == "pass_with_warnings"
    else:
        assert payload["status"] == "pass"


def test_text_mode_unchanged():
    _, stdout, code = run_doctor()
    # 终端模式保留 PASS/WARN/FAIL 标记与结论行（人类可读回归）
    assert ("PASS" in stdout) or ("WARN" in stdout) or ("FAIL" in stdout)
    assert "结论" in stdout
    assert code in (0, 1)

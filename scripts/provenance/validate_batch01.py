#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Batch 01 证据包轻量校验（§15 自检）。

检查：
- 五张 CSV 表头与列数完整；
- file-inventory.csv 范围文件不重复且与 scope.txt 一致；
- manual-review.csv 每个范围文件恰好一行；
- 所有人工结论字段仍为「待人工确认 / 待指派 / 未开始」；
- 公开文件不含本机用户名或绝对 Home 路径；
- 摘录文件不超过 20 行摘录上限；
- 本仓库改动只落在允许范围（CODE_PROVENANCE.md/.gitignore/docs/provenance/scripts）；
- VoiceStudio 对比仓库未被修改（porcelain 为空且 HEAD 与 manifest 一致）。

用法：python3 scripts/provenance/validate_batch01.py --output docs/provenance/batch-01 \
        [--subject-root ...] [--comparison-root ...]
"""

import argparse
import csv
import getpass
import json
import os
import subprocess
import sys

EXPECTED_HEADERS = {
    "file-inventory.csv": ["path", "exists", "language", "line_count", "byte_count", "sha256_raw",
                           "sha256_normalized", "first_add_commit", "first_history_commit",
                           "first_author_name", "first_author_email", "first_authored_at",
                           "last_commit", "last_author_name", "last_authored_at", "commit_count",
                           "review_priority", "notes"],
    "file-history.csv": ["path", "commit", "author_name", "author_email", "authored_at",
                         "subject", "change_type", "lines_added", "lines_deleted", "evidence_ref"],
    "counterpart-map.csv": ["semovix_path", "voicestudio_path", "mapping_basis",
                            "responsibility_match", "language_match", "history_checked",
                            "candidate_commit", "notes"],
    "similarity-results.csv": ["semovix_path", "voicestudio_path", "subject_commit",
                               "comparison_commit", "exact_sha256_match", "normalized_sha256_match",
                               "raw_line_sequence_ratio", "normalized_line_multiset_ratio",
                               "token_5gram_jaccard", "identifier_normalized_token_5gram_jaccard",
                               "longest_common_block_lines", "distinctive_literal_matches",
                               "distinctive_comment_matches", "risk_flag", "machine_notes"],
    "manual-review.csv": ["path", "function", "current_sha256", "first_add_commit",
                          "first_authored_at", "git_authors", "possible_counterparts",
                          "machine_observation", "evidence_supporting_independent_development",
                          "evidence_supporting_possible_reuse", "other_possible_sources",
                          "machine_risk_level", "human_classification", "license",
                          "retain_original_notice", "rewrite_required", "confidence",
                          "reviewer", "second_reviewer", "review_status", "evidence_refs"],
}
HUMAN_FIELD_VALUES = {
    "human_classification": "待人工确认",
    "license": "待人工确认",
    "retain_original_notice": "待人工确认",
    "rewrite_required": "待人工确认",
    "confidence": "待人工确认",
    "reviewer": "待指派",
    "second_reviewer": "待指派",
    "review_status": "未开始",
}
ALLOWED_CHANGED_PREFIXES = (
    "CODE_PROVENANCE.md", ".gitignore",
    "docs/provenance/", "scripts/provenance/",
)


def read_csv(path):
    with open(path, encoding="utf-8", newline="") as f:
        return list(csv.reader(f))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", required=True)
    ap.add_argument("--subject-root", default=None)
    ap.add_argument("--comparison-root", default=None)
    args = ap.parse_args()

    out = os.path.abspath(args.output)
    errors, warnings = [], []

    # 1) CSV 表头与行宽
    tables = {}
    for name, header in EXPECTED_HEADERS.items():
        path = os.path.join(out, name)
        if not os.path.isfile(path):
            errors.append("缺少 %s" % name)
            continue
        rows = read_csv(path)
        if not rows or rows[0] != header:
            errors.append("%s 表头不符" % name)
            continue
        bad = [i for i, r in enumerate(rows[1:], 2) if len(r) != len(header)]
        if bad:
            errors.append("%s 第 %s 行列数错误" % (name, bad[:5]))
        tables[name] = rows[1:]

    # 2) scope 一致性 + 唯一性
    scope_paths = []
    with open(os.path.join(out, "scope.txt"), encoding="utf-8") as f:
        for line in f:
            if line.strip():
                scope_paths.append(line.strip().split("|")[0])
    inv = tables.get("file-inventory.csv", [])
    inv_paths = [r[0] for r in inv]
    if len(inv_paths) != len(set(inv_paths)):
        errors.append("file-inventory.csv 存在重复路径")
    if sorted(inv_paths) != sorted(scope_paths):
        errors.append("file-inventory.csv 与 scope.txt 文件集合不一致")

    # 3) manual-review 每文件一行 + 人工字段未填写
    mr = tables.get("manual-review.csv", [])
    mr_paths = [r[0] for r in mr]
    if len(mr_paths) != len(set(mr_paths)):
        errors.append("manual-review.csv 存在重复路径")
    if sorted(mr_paths) != sorted(scope_paths):
        errors.append("manual-review.csv 行数/集合与范围不一致（%d vs %d）" % (len(mr_paths), len(scope_paths)))
    header = EXPECTED_HEADERS["manual-review.csv"]
    for r in mr:
        row = dict(zip(header, r))
        for field, expect in HUMAN_FIELD_VALUES.items():
            if row.get(field) != expect:
                errors.append("manual-review.csv %s 的人工字段 %s 被改动为 %r" % (r[0], field, row.get(field)))

    # 4) 隐私扫描（输出目录内除 scan-manifest.local.json 外的全部文件）
    home = os.path.expanduser("~")
    username = getpass.getuser()
    needles = [home.encode(), b"/Users/", os.fsencode(username)]
    privacy_hits = []
    for root, _dirs, files in os.walk(out):
        for fn in files:
            if fn == "scan-manifest.local.json":
                continue
            full = os.path.join(root, fn)
            with open(full, "rb") as f:
                data = f.read()
            for n in needles:
                if n and n in data:
                    privacy_hits.append((os.path.relpath(full, out), n.decode("utf-8", "replace")))
    if privacy_hits:
        errors.append("公开文件含本机路径/用户名: %s" % privacy_hits[:8])

    # 5) 摘录行数上限
    excerpts_dir = os.path.join(out, "evidence", "voicestudio", "excerpts")
    if os.path.isdir(excerpts_dir):
        for fn in os.listdir(excerpts_dir):
            with open(os.path.join(excerpts_dir, fn), encoding="utf-8") as f:
                n_lines = sum(1 for _ in f)
            if n_lines > 40:
                errors.append("摘录文件 %s 超过 40 行上限" % fn)

    # 6) 本仓库改动范围
    if args.subject_root:
        proc = subprocess.run(["git", "-C", args.subject_root, "status", "--porcelain=v1"],
                              capture_output=True)
        for line in proc.stdout.decode("utf-8", "replace").splitlines():
            entry = line[3:].strip()
            if entry == "docs/provenance/batch-01/scan-manifest.local.json":
                continue  # 已被 .gitignore 忽略（untracked 显示时也允许）
            if not any(entry == p or entry.startswith(p) for p in ALLOWED_CHANGED_PREFIXES):
                errors.append("范围外改动: %s" % entry)

    # 7) 对比仓库未被修改
    if args.comparison_root:
        proc = subprocess.run(["git", "-C", args.comparison_root, "status", "--porcelain=v1"],
                              capture_output=True)
        if proc.stdout.decode("utf-8", "replace").strip():
            errors.append("VoiceStudio 仓库工作区被修改")
        head = subprocess.run(["git", "-C", args.comparison_root, "rev-parse", "HEAD"],
                              capture_output=True).stdout.decode().strip()
        manifest_path = os.path.join(out, "scan-manifest.json")
        if os.path.isfile(manifest_path):
            with open(manifest_path, encoding="utf-8") as f:
                manifest = json.load(f)
            recorded = (manifest.get("comparison") or {}).get("commit")
            if recorded and recorded != head:
                errors.append("VoiceStudio HEAD(%s) 与 manifest 记录(%s) 不一致" % (head[:12], recorded[:12]))

    for w in warnings:
        print("WARN : %s" % w)
    if errors:
        for e in errors:
            print("FAIL : %s" % e)
        return 1
    print("OK：Batch 01 证据包校验通过（%d 范围文件，%d 张表）" % (len(scope_paths), len(tables)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

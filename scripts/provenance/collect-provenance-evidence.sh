#!/usr/bin/env bash
# Batch 01 证据采集包装器：解析仓库根目录，调用 Python 采集器并校验输出。
# 对比仓库只读；本脚本不修改任何生产代码或对比仓库。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
SUBJECT_ROOT="${SEMOVIX_REPO_ROOT:-$REPO_ROOT}"
OUTPUT_DIR="${1:-$REPO_ROOT/docs/provenance/batch-01}"
PY="${PYTHON3:-python3}"

# 对比仓库解析顺序（不得硬编码本机绝对路径）：
#   1. VOICESTUDIO_REPO_ROOT 环境变量
#   2. $HOME/workspace/github_workspace/VoiceStudio
#   3. 仓库根目录附近的常见位置
COMPARISON_ROOT="${VOICESTUDIO_REPO_ROOT:-}"
if [ -z "$COMPARISON_ROOT" ]; then
  for candidate in \
    "$HOME/workspace/github_workspace/VoiceStudio" \
    "$REPO_ROOT/../VoiceStudio" \
    "$REPO_ROOT/../../VoiceStudio" \
    "$REPO_ROOT/../../github_workspace/VoiceStudio"; do
    if [ -d "$candidate/.git" ]; then
      COMPARISON_ROOT="$candidate"
      break
    fi
  done
fi
if [ -z "$COMPARISON_ROOT" ]; then
  echo "错误：未找到 VoiceStudio 对比仓库，请设置 VOICESTUDIO_REPO_ROOT" >&2
  exit 1
fi

echo "subject   : $SUBJECT_ROOT"
echo "comparison: $COMPARISON_ROOT（只读）"
echo "output    : $OUTPUT_DIR"
"$PY" "$SCRIPT_DIR/collect_batch01.py" \
  --subject-root "$SUBJECT_ROOT" \
  --comparison-root "$COMPARISON_ROOT" \
  --output "$OUTPUT_DIR"

# 输出完整性校验
for f in scope.txt scan-manifest.json file-inventory.csv file-history.csv \
         counterpart-map.csv similarity-results.csv manual-review.csv \
         evidence/machine-summary.json; do
  if [ ! -s "$OUTPUT_DIR/$f" ]; then
    echo "错误：缺少输出文件 $OUTPUT_DIR/$f" >&2
    exit 1
  fi
done

echo "OK：Batch 01 证据已写入 $OUTPUT_DIR"

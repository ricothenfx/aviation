#!/usr/bin/env bash
#
# C-MAPSS FD001 pinned download + checksum verification (data-model.md §8,
# data-ethics.md §1). See README.md in this directory for provenance and the
# cross-mirror verification evidence behind the pins.
#
# Test hooks (used by the tamper test, tests/test_cmapss_download.py):
#   CMAPSS_DATA_DIR    target directory (default: ./data next to this script)
#   CMAPSS_BASE_URL    mirror base URL (default: the pinned GitHub mirror)
#   CMAPSS_VERIFY_ONLY skip fetching; verify existing files only (tamper test)
#
# A checksum mismatch exits non-zero with a FATAL message — a tampered or
# partial download must never reach training/seeding (DoD F4).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${CMAPSS_DATA_DIR:-$SCRIPT_DIR/data}"
BASE_URL="${CMAPSS_BASE_URL:-https://raw.githubusercontent.com/edwardzjl/CMAPSSData/master}"
VERIFY_ONLY="${CMAPSS_VERIFY_ONLY:-0}"

# Pinned sha256 values (see README.md for how they were established).
declare -A PIN=(
  [train_FD001.txt]="963b5e22825b34d8b21c69e1aeb4af3e647050eb672ee8834ba4b5d91d2de0f8"
  [test_FD001.txt]="3cda7109ce17bafb5443f2ac926cfcf88154b941b8c4cf95eb55d1ddd6f52851"
  [RUL_FD001.txt]="a19c8ec94931949d0485bdc35118206e9c81c4547b422efb9cf86f4ceddbceca"
  [readme.txt]="4f5270554b775c67e73aff383c5436fd329d6e4cc3d3a116913276fae511269b"
)

FILES=(train_FD001.txt test_FD001.txt RUL_FD001.txt readme.txt)

mkdir -p "$DATA_DIR"

for f in "${FILES[@]}"; do
  dest="$DATA_DIR/$f"
  if [[ "$VERIFY_ONLY" != "1" && ! -f "$dest" ]]; then
    curl -fsSL --retry 3 --connect-timeout 15 -o "$dest" "$BASE_URL/$f"
  fi
  if [[ ! -f "$dest" ]]; then
    echo "FATAL: $f missing in $DATA_DIR (run download.sh without CMAPSS_VERIFY_ONLY)" >&2
    exit 1
  fi
  actual="$(sha256sum "$dest" | awk '{print $1}')"
  if [[ "$actual" != "${PIN[$f]}" ]]; then
    echo "FATAL: sha256 mismatch for $f — refusing to use it (data-model.md §8)" >&2
    echo "  expected: ${PIN[$f]}" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
  echo "ok: $f ${PIN[$f]:0:12}..."
done

echo "C-MAPSS FD001 verified: ${#FILES[@]} pinned files in $DATA_DIR"

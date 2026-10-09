#!/usr/bin/env bash
# sn_audit.sh — Write sn_audit.txt listing the SN of every tracked source file
# Uses only the last SN match per file — avoids false hits from doc examples in .md files

set -uo pipefail
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$PROJ/sn_audit.txt"

cd "$PROJ"

{
    echo "--- TopoSite SN Audit: $(date '+%Y-%m-%d %H:%M:%S') ---"
    find . \( -name .git -o -name node_modules -o -name .venv -o -name venv -o -name __pycache__ \
              -o -name '*.egg-info' -o -name build -o -name dist -o -name vendor \) -prune -o \
           -type f \( -name '*.py' -o -name '*.sh' -o -name '*.toml' -o -name '*.md' \
              -o -name '*.js' -o -name '*.php' -o -name '*.java' -o -name '*.html' \
              -o -name '*.yml' -o -name '*.yaml' \) -print | sort |
    while read -r f; do
        sn=$(grep -oE '^(//|#|<!--) SN: [0-9]+' "$f" | tail -1 | grep -oE '[0-9]+$')
        [ -n "$sn" ] && printf '%-45s %s\n' "${f#./}" "$sn"
    done
} > "$OUT"

echo "SN Audit written to $OUT" >&2

# SN: 00001

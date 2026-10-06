#!/usr/bin/env bash
# gen_line_count.sh — Daily line count snapshot for TopoSite
# Writes Line_Counts/line_count_YYYYMMDD.md in the project root.
# Scheduled via crontab: 0 1 * * *

set -uo pipefail
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
DATE="$(date +%Y%m%d)"
DISPLAY_DATE="$(date '+%Y-%m-%d')"
OUT="$PROJ/Line_Counts/line_count_${DATE}.md"

cd "$PROJ"

# List files matching a name pattern under a directory (skips venvs/caches)
files() {
    [ -d "$1" ] || return 0
    find "$1" \( -name .venv -o -name venv -o -name __pycache__ \) -prune -o \
         -type f -name "$2" -print
}

# Count lines in a list of files on stdin; emit "N path" sorted desc
scan() {
    while read -r f; do
        [ -f "$f" ] || continue
        printf '%d %s\n' "$(wc -l < "$f")" "$f"
    done | sort -rn
}

# Sum first column of "N path" lines (awk always exits 0)
sumlines() { awk '{s+=$1} END {print s+0}'; }

# Format integer with comma thousands separator
fmt() {
    local n=$1
    if   [ "$n" -ge 1000000 ]; then
        printf '%d,%03d,%03d' $(( n/1000000 )) $(( n/1000%1000 )) $(( n%1000 ))
    elif [ "$n" -ge 1000 ]; then
        printf '%d,%03d' $(( n/1000 )) $(( n%1000 ))
    else
        printf '%d' "$n"
    fi
}

# Print markdown table rows from "N path" input
rows() {
    while read -r n path; do
        printf '| `%s` | %s |\n' "$path" "$(fmt "$n")"
    done
}

# Print non-blank lines from multiple variables (avoids grep exit-1 on empty)
nonblank() { printf '%s\n' "$@" | awk 'NF'; }

mkdir -p "$PROJ/Line_Counts"

# ---------------------------------------------------------------------------
# Collect all sections
# ---------------------------------------------------------------------------
py=$(     files src '*.py'                                  | scan)
web=$(  { files src '*.js'; files src '*.html'; files src '*.css'; } | scan)
php=$(    files pfsense '*.php'                             | scan)
tests=$(  files tests '*.py'                                | scan)
shell=$(  files scripts '*.sh'                              | scan)
docs_md=$(ls ./*.md 2>/dev/null | sed 's#^\./##'            | scan)

# ---------------------------------------------------------------------------
# Compute totals
# ---------------------------------------------------------------------------
t_py=$(   nonblank "$py"      | sumlines)
t_web=$(  nonblank "$web"     | sumlines)
t_php=$(  nonblank "$php"     | sumlines)
t_test=$( nonblank "$tests"   | sumlines)
t_sh=$(   nonblank "$shell"   | sumlines)
t_md=$(   nonblank "$docs_md" | sumlines)
t_grand=$(( t_py + t_web + t_php + t_test + t_sh + t_md ))

# ---------------------------------------------------------------------------
# Write markdown
# ---------------------------------------------------------------------------
section() {
    printf '\n### %s\n\n| File | Lines |\n|---|---|\n' "$1"
    nonblank "$2" | rows
}

{
cat <<HEADER
# TopoSite Line Count — ${DISPLAY_DATE}

## Grand Total: $(fmt $t_grand) lines

| Category | Lines |
|---|---|
| Python (\`src/\`) | $(fmt $t_py) |
| Web front end (\`.js\` / \`.html\` / \`.css\`) | $(fmt $t_web) |
| PHP (\`pfsense/\`) | $(fmt $t_php) |
| Tests (\`tests/\`) | $(fmt $t_test) |
| Shell (\`scripts/\`) | $(fmt $t_sh) |
| Markdown (\`.md\`) | $(fmt $t_md) |
| **Total** | **$(fmt $t_grand)** |

---

## By File
HEADER
section "Python (\`src/\`)"       "$py"
section "Web front end"          "$web"
section "pfSense (\`pfsense/\`)"  "$php"
section "Tests (\`tests/\`)"      "$tests"
section "Scripts (\`scripts/\`)"  "$shell"
section "Documentation (\`.md\`)" "$docs_md"
} > "$OUT"

echo "$(date '+%Y-%m-%d %H:%M:%S')  Written: $OUT" >&2

# SN: 00001

#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
helper=$(sed -n '/^cpu_percent() {$/,/^}$/p' "$repo_dir/shell/cgi/router-proxy-control.cgi")
[ -n "$helper" ]
eval "$helper"

work_dir=$(mktemp -d)
trap 'rm -f "$work_dir/0"; rmdir "$work_dir"' EXIT
cd "$work_dir"

expect_usage() {
  result=$(cpu_percent "$1" "$2")
  if [ "$result" != "$3" ]; then
    printf 'Expected %s%% for %s -> %s, got %s\n' "$3" "$1" "$2" "$result" >&2
    exit 1
  fi
}

# Taken from a live router sample while the UI incorrectly reported overload.
expect_usage '9136027 8456579' '9136837 8457334' 6
expect_usage '10000 5000' '10800 5030' 96
expect_usage '10000 5000' '10800 5800' 0

if cpu_percent '10000 5000' '10000 5000' || cpu_percent '' '10800 5800'; then
  printf 'Accepted invalid CPU samples\n' >&2
  exit 1
fi
[ ! -e 0 ]
printf 'Proxy CPU measurement tests passed.\n'

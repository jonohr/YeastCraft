#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Scan source/development dependencies and a local runtime image. No publication.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output=${1:-$(mktemp -d /tmp/fermentrack-audit.XXXXXX)}
image=${2:-fermentrack-rs:local}
scanner=aquasec/trivy@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb
mkdir -p "$output"
output=$(CDPATH= cd -- "$output" && pwd)
case "$output/" in "$root/"*) echo 'Keep audit output outside the source tree.' >&2; exit 1 ;; esac
docker run --rm -v "$root:/src:ro" -v "$output:/audit" "$scanner" fs \
  --scanners vuln,secret,misconfig --include-dev-deps \
  --skip-dirs /src/.git,/src/rust/target,/src/ui/node_modules,/src/ui/dist,/src/ui/test-results,/src/state,/src/private-import,/src/fixtures,/src/tools/ispindel-emulator/target \
  --cache-dir /audit/cache --format json --output /audit/source.json /src
docker save -o "$output/image.tar" "$image"
docker run --rm -v "$output:/audit" "$scanner" image --input /audit/image.tar \
  --scanners vuln --cache-dir /audit/cache --format json --output /audit/runtime.json
rm "$output/image.tar"
printf 'Reports: %s/source.json and runtime.json\nReview findings; scanner exit 0 does not mean zero findings.\n' "$output"

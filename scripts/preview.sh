#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
mkdir -p state
export SQLITE_TMPDIR="$PWD/state"
exec rust/target/release/fermentrack-rs --db state/preview.sqlite --listen 127.0.0.1:8315 --static ui/dist --import-root private-import

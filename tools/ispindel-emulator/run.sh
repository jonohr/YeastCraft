#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
set -eu
emulator_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if command -v cargo >/dev/null 2>&1; then
    emulator_cargo=cargo
else
    emulator_cargo="$HOME/.cargo/bin/cargo"
fi
exec "$emulator_cargo" run --quiet --release --locked --manifest-path "$emulator_dir/Cargo.toml" -- "$@"

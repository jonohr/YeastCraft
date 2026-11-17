# Attribution

Fermentrack RS builds on the ideas, protocol behavior and legacy data formats of
[Fermentrack](https://github.com/thorrak/fermentrack), by John Beeler, Fredrik Steen
and contributors. The upstream reference revision used during development was
`1aea05b07b9445edce2f39480b03c93eced125e6`.

Rust/React code, emulators and tools added for RS are GPL-3.0-only unless a file
states otherwise. The full license is in LICENSE. The upstream Fermentrack MIT
notice is retained in LICENSES/Fermentrack-MIT.txt. The BrewPi script's GPLv3 text
is retained in LICENSES/BrewPi-GPL-3.0.md. These notices do not relicense upstream
code. This repository does not include the original Python application or firmware.

The geometric RS lettering is original RS artwork under GPL-3.0-only.
The flask and interface icons derive from Lucide/Feather; their ISC notice is
retained in design/brand/LICENSE-lucide.txt and LICENSES/Lucide-ISC.txt. Dependencies retain their own licenses,
and Cargo/npm lockfiles identify the dependency versions.

This public-source snapshot starts with its own history. It excludes private
operational records and deployment history. Upstream reference material is available
from the original project, rather than from nonexistent commits in this repository.

## Dependency notices and source

Dependency copyright and license texts are indexed in `LICENSES/third-party/README.md`
and `inventory.json`. The standalone image carries them in
`/usr/share/doc/fermentrack-rs/licenses.tar.gz`. Runtime library notices are also under
`/usr/share/doc/`. Dependency code is not relicensed indiscriminately by this notice.

The unchanged MPL-2.0-covered serialport 4.10.1 code is additionally available under
GPL-3.0-only as part of this GPLv3 Larger Work under MPL section 3.3; its MPL rights
and notices remain available. Its exact source is listed in the inventory and
included in the corresponding-source bundle prepared for image releases.

Binary releases must be accompanied by the matching source bundle described in
`docs/LICENSE_REVIEW.md`, including the dependency and copied runtime-library sources.

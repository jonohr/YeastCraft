# License and repository-content review — 2026-11-17

Scope: the clean YeastCraft repository, locked dependencies, shipped artwork and the three
minimal runtime images. This is a technical distribution review, not a legal opinion
about trademarks or every possible downstream use.

## Distribution contents

No incompatible mandatory dependency license was identified for this GPL-3.0-only
project. The repository retains upstream notices for 287 package/toolchain records,
including all locked Rust platforms, installed npm build/test tools and the eleven
npm production packages. Build-only entries are not claims of runtime inclusion.

`LICENSES/third-party/inventory.json` records package versions, license expressions,
original-source URLs and notice text references. `README.md` in the same directory
provides a human-readable index. Duplicate identical texts share one content-hash file;
text contents are unmodified. `scripts/collect-licenses.py` reproduces the collection
after Cargo fetch/npm ci. Platform-specific esbuild/Rollup binaries inherit their
matching-version parent package's notice. These are build tools, not shipped runtime.

The Docker image includes the notices as
`/usr/share/doc/yeastcraft/licenses.tar.gz`, alongside the project's uncompressed
LICENSE and NOTICE.md. Copied glibc/GCC/CA material retains Debian copyright notices
and exact package provenance. Compression keeps the minimal image small.

## Specific checks

- Fermentrack's MIT notice and BrewPi GPLv3 text remain intact. YeastCraft is described as
  independent; no original Python application, firmware binaries or private Git
  history are included. This is not a claim to upstream ownership or endorsement.
- Lucide/Feather-derived icons and the flask identity retain their ISC attribution.
  The tracked raster icons are derivatives of those supplied SVG assets. No external
  font files or unrelated stock photography are distributed in the tracked assets.
- MIT/Apache/BSD/ISC/0BSD/Zlib/Unicode notices are retained. For permissive alternatives
  such as MIT OR GPL and MIT OR Apache OR LGPL, distribution relies on the permissive
  alternative; the original expression and notices are preserved rather than rewritten.
- `serialport 4.10.1` uses MPL-2.0. Its package files do not contain an Exhibit B
  incompatibility designation. The complete MPL text, original short notice and exact
  source URL are included. As part of the GPLv3 Larger Work, the covered code is
  additionally available under GPLv3 via MPL section 3.3, with MPL rights preserved.
  See [Mozilla's guidance](https://www.mozilla.org/en-US/MPL/2.0/FAQ/), especially Q8/Q14.
- `ring` has combined Apache/ISC requirements, not an either/or choice. Its BoringSSL,
  other-bits and nested third-party notices are included.
- SQLite's bundled C implementation has its public-domain dedication retained in
  `SQLite-public-domain.txt`; the Rust wrapper's MIT notice is separate.
- `r-efi` expresses licensing and copyright in AUTHORS rather than a LICENSE file;
  that complete notice is retained, with full common license texts available.
- `webpki-roots` certificate data uses CDLA-Permissive-2.0, whose full text accompanies
  the data. See [the license's sharing condition](https://cdla.dev/permissive-2-0/).
- The matching Rust 1.99.1 standard-library copyright report and license texts are
  included. Host and pinned image toolchains were checked to match.
- glibc is dynamically linked; no LGPL library modifications or static relinking
  exception are claimed. GCC runtime exceptions and Debian notices are preserved.
  Sources for copied runtime libraries accompany the prepared source bundle.

## Corresponding source at release time

`scripts/prepare-source-bundle.py OUTPUT.tar.gz` packages a committed snapshot plus
all locked Cargo/npm package archives, original upstream source revisions for the
eleven production JavaScript dependencies, matching Rust library sources and original
Debian glibc/GCC/CA source packages. Registry archives are verified against lockfile
checksums; Rust against its toolchain manifest; Debian against source descriptors.
The output is outside the checkout and is never uploaded by the script.

When publishing an image, publish its matching source bundle alongside it and link
both from the same release. Do not publish a binary release first and promise sources
later. Preserve notices and source access for unchanged third-party code as well.
Regenerate this inventory/source bundle when locks or toolchain/base versions change.
The [release workflow](RELEASING.md) packages source from the same commit as its
images and rejects mismatched runtime-library versions before assembling a release.

## Repository contents

The repository has its own YeastCraft history, without private deployment history,
measurements or credentials. Tracked artwork, synthetic protocol fixtures,
source/build instructions and attribution are included. Generated databases,
build products and private state are ignored.

CI scans the committed history for secrets on each candidate. Public upstream
authorship/contact details in notices are intentional attribution. The npm
manifest's `private: true` prevents npm package publishing; it does not prevent
source publication.

## Release evidence

Each candidate includes `release-manifest.json`, per-image provenance, the complete
source archive and `SHA256SUMS`. Use those receipts for the version being released;
a locally prepared archive from another commit is not a substitute. GitHub Actions
artifacts are temporary; published binary releases must retain their matching
source assets for redistribution.

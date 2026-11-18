# Build-tool advisory review

Reviewed 2026-11-17. This is a scoped risk decision, not a patched dependency or a
claim that the scanner is wrong. Raw Trivy reports retain the finding.

## picomatch 4.0.7 — CVE-2026-112366

The [upstream advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) describes
a denial of service from pathological glob patterns. No patched version is listed;
the npm registry's current release is 4.0.7.

In this project, picomatch is a **development dependency** used by Vite, fdir and
tinyglobby. `npm ls --omit=dev picomatch` is empty, the lockfile marks the package
`dev: true`, and the application source does not import it. The final image contains
static frontend assets and the Rust server, not Node or node_modules. Normal HTTP
requests and sensor packets are not passed to this build-time glob parser.

The remaining exposure is during development/building with hostile glob inputs.
Build configuration and changes from contributors must already be treated as
executable code. CI uses disposable hosted runners, bounded job times and no
production credentials. Do not expose the Vite development server as production.

The CI gate accepts this **one** finding only for `ui/package-lock.json`, npm
picomatch exactly 4.0.7, when it remains a dev dependency, has no reported fixed
version, and the report is a source-repository scan. It never applies to runtime
image reports, secrets, other packages or other CVEs. The exception expires on
**2026-12-17**; expiry or an available fix makes the finding blocking again.

The finding stays visible in scan artifacts and gate output. Review the upstream
fix when available, update the lockfile/notices and remove the exception. Reassess
immediately if dependency usage or runtime packaging changes.

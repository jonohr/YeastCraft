# From a change to a release

Small changes still deserve a clear trail: branch, pull request, green checks,
then merge. The workflows build candidates automatically; publishing a version
remains a deliberate maintainer action.

## Everyday changes

1. Create a branch and make the change there.
2. Open a pull request against `main`, with the relevant issue and validation.
3. Wait for **CI passed** and **Assemble verified release candidate**.
4. Review the change and merge. Avoid direct pushes to `main`.

The release-candidate workflow runs on pull requests and pushes to `main`, and can
also be started manually from Actions. It calls the reusable CI workflow. PR runs
use GitHub's proposed merge commit; `main` runs package the actual merged commit.
An updated PR cancels its older run. Do not release artifacts from a PR merge ref.

Checks include:

- Locked Rust tests and Clippy, plus the iSpindel emulator's Rust tests.
- Frontend build and mobile/desktop Chromium workflows.
- Standalone, iSpindel, BrewPi chamber and Tilt simulator acceptance.
- Fresh Compose and image acceptance on amd64, ARM64 and ARMv7 (ARM via QEMU).
- Gitleaks history scanning, Trivy source/runtime reports and a gate on detected
  secrets, unreviewed high/critical vulnerabilities and high/critical failed configuration checks.
  The [picomatch build-only decision](security/BUILD_TOOLS.md) is narrowly scoped and expires.
- Release assembly checks for missing images, mismatched commits, changed image
  identities and runtime-library/source-version mismatches.

No hardware, Brewfather account or other external export destination is needed.
The image test harness runs with the host test user's UID for temporary bind-mount
access. Fresh Compose separately checks the actual shipped non-root configuration.
Security reports retain lower-severity findings; a green result is not a security
certification. Actions are pinned to commit IDs, with read-only permissions except
for the draft-release and registry-publishing jobs.

### Enforce the workflow on GitHub

The convention above does not itself prevent a direct push. In repository settings,
configure a branch ruleset for `main` to require a pull request, successful **CI
passed** and **Assemble verified release candidate** checks, and block force pushes
and deletion. Select the checks after a completed run makes them available. Review
bypass permissions explicitly. Availability of private-repository rules depends on
the GitHub account plan. No branch-protection rule is installed by these workflows.

## What a candidate contains

Download `yeastcraft-release-candidate` from the Actions run. It contains:

| File                                      | Purpose                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `yeastcraft-linux-ARCH.docker.tar.gz` | Tested standalone Docker image for amd64, arm64 or armv7                              |
| `yeastcraft-source.tar.gz`            | Exact committed source, locked dependencies and corresponding runtime-library sources |
| `image-ARCH.json`                         | Per-image commit, ID, architecture, tag and runtime packages                          |
| `release-manifest.json`                   | Combined image provenance                                                             |
| `compose.yml` and `INSTALL.txt`           | Install a loaded image without compiling or pulling from a registry                   |
| `RELEASE-NOTES.md`                        | Preview notes to review before publication                                            |
| `SHA256SUMS`                              | SHA-256 checksums for every other asset                                               |

Artifacts are retained for **seven days**. They are temporary CI output, not a
permanent download service. A GitHub release stores the complete asset set beyond
that period. Always distribute the corresponding source alongside the images.
This package is a standalone container installation, not a native host installer.

The source packager currently pins the runtime source-package versions. Assembly
fails if an image contains newer libraries, even when its build succeeds. Update
the source selection and repeat the license review when that happens; do not skip
the mismatch check. Image layers carry the source commit as an OCI label.

## Prepare a version

After the intended commit is merged and green, create and push a version tag:

```sh
git switch main
git pull --ff-only
git tag -a v0.1.0-preview.1 -m 'YeastCraft preview 1'
git push origin v0.1.0-preview.1
```

This example is a future release action, not a tag already created by setup.
The tag triggers fresh verification and packaging, then creates a **draft,
prerelease** GitHub release with all assets. It does not publish it. Rerunning the
same tag can replace assets only while the release remains a draft; a published
release is not overwritten by the candidate workflow.

Before publishing, review the generated notes, security reports, compatibility
limits and matching source/checksums. Test the installation instructions using a
fresh volume. Verify private vulnerability reporting is available. Choose the
repository/package visibility deliberately; the workflows do not change it.

## Publish the reviewed release

Publishing the GitHub release triggers `publish.yml`. It downloads the complete
release, checks checksums and provenance, loads the tested image archives and
checks their image IDs. It pushes those images to GHCR **without rebuilding** and
creates the multi-platform tag:

```text
ghcr.io/jonohr/yeastcraft:v0.1.0-preview.1
```

This is the naming scheme, not a claim that this tag already exists. The workflow
uses the repository's `GITHUB_TOKEN`; no personal registry token is required.
Check package visibility/access separately before advertising anonymous pulls.
There is deliberately no moving `latest` tag for these early previews.

If registry upload fails, the release archives remain available for `docker load`.
Fix the cause and rerun the publishing job; do not rebuild different images under
the same version. Monitor the registry workflow to completion before announcing
registry availability.

## Local packaging checks

```sh
python3 scripts/test-release.py
```

To reproduce a real candidate, first build and acceptance-test images with
`VCS_REF` set to the intended committed revision, then use `package-image.py` for
each architecture, `prepare-source-bundle.py` for the matching sources and
`assemble-release.py` for the output folder. Keep output outside the checkout.
The workflows contain the exact commands; no generated assets belong in Git.

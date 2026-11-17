# Memory investigation — 2026-11-17

## Experience from the original installation

Historical operating notes from the migration recorded approximately 490 MiB
for the original Fermentrack container using `docker stats`. An early RS snapshot
with collection and temperature control active was 2.9 MiB. A later RS snapshot
was 10.49 MiB by Docker accounting and 16,672 KiB process RSS (about 16.3 MiB).
The original application was stopped after the control handover.

These are recorded observations, not new measurements taken for this document.
They span different application revisions and workloads, without a matched
request sequence or authentication setup. They describe our experience replacing
one installation, not a general performance ratio or full functional equivalence.
The controlled comparisons below compare RS versions with each other, not RS
against upstream Fermentrack. Server measurements exclude the browser, host-wide
services and any external authentication provider.

The architectural change matters alongside the implementation language: RS
combines HTTP serving, collection and control in one Rust process, uses SQLite,
and does not need separate Python workers, Redis or a Node runtime. Replacing the
container base with `scratch` reduced image size, but did not meaningfully lower
steady-state RSS in our matched tests below.

## Investigation scope

The initial fresh-install measurement was not a matched version comparison: it
compared an instance which had created a local account and logged in against an
existing production instance using external authentication. Do not attribute that
difference to Tilt ingestion.

## Controlled comparison

The pre-Tilt image and the experimental Tilt image were run separately on the same
Linux x86_64 Docker host, with identical copies of a synthetic SQLite database:
one existing local account, one iSpindel sensor and 1,000 measurements. Each run
used collection enabled, control/exports disabled, the same limits, 300 identical
iSpindel submissions and history retrieval. No production database or credentials
were used. Containers and temporary databases were removed afterward.

Docker-style usage below is cgroup v2 memory.current minus inactive_file. RSS and
anonymous RSS were read independently from the application process's /proc status.
These are short observations from one run per case, not long-term bounds or a
statistical performance benchmark. Thread scheduling changes retained arena sizes.

| Case | Docker-style MiB after traffic | Process RSS MiB after traffic |
| --- | ---: | ---: |
| Pre-Tilt, proxy authentication | 4.32 | 8.86 |
| Tilt version, proxy authentication | 4.31 | 9.77 |
| Pre-Tilt, one local login | 21.30 | 26.28 |
| Tilt version, one local login | 21.83 | 27.39 |
| Tilt version, local login, experimental allocator override | 4.49 | 10.30 |

With the default allocator, ten additional serial logins and four simultaneous
logins left 194.57 MiB (pre-Tilt) and 175.61 MiB (Tilt version) charged after a
three-second settling period. Anonymous process memory accounted for most of it.
This behavior is present in both versions, rather than introduced by Tilt.

## Cause and isolated mitigation experiment

The pinned Argon2 dependency defaults to 19 MiB of working memory per hash. Current
local login code computes a dummy hash and then verifies the submitted password,
even for an existing account. These are sequential computations within each login.
Database work runs on Tokio blocking threads. glibc may retain freed buffers in
heap arenas instead of immediately returning their pages to the kernel.

A new-version test container was started with exactly one allocator change:

```yaml
environment:
  MALLOC_MMAP_THRESHOLD_: "131072"
```

No password hash, work factor, algorithm or authentication behavior was changed.
After the same serial/concurrent login sequence, Docker-style usage settled at
4.09 MiB, process RSS at 10.20 MiB and anonymous RSS at 3.22 MiB. Process peak RSS
was still 85.35 MiB during the concurrent hash workload: the setting releases
working buffers afterward; it does not eliminate the work memory needed while
password verification is in progress.

The allocator intervention strongly supports retained Argon2 allocation memory as
the explanation for the observed growth. It is not proof that every possible leak
or long-running growth pattern has been ruled out.

[glibc allocator controls](https://sourceware.org/glibc/manual/latest/html_node/Malloc-Tunable-Parameters.html)
document the mmap threshold and its dynamic default behavior. Fixing the threshold
makes large allocations eligible for separately releasable mappings. This is a
glibc-specific tuning experiment, not a Rust language requirement.

## Interpretation and next change

- No meaningful Docker-memory regression was observed with matched proxy auth and
  traffic; the new process RSS was approximately 0.9 MiB higher in this run.
- The earlier 1.5 MiB cold-start Docker value was not the process's entire resident
  footprint. The new process started around 7.4 MiB RSS. Shared file pages and
  cgroup/cache accounting make these metrics different.
- The tested allocator setting is now included in the standalone image; see the
  implementation verification below.
- Separately review the per-request dummy-hash computation and bound expensive
  password-hash concurrency, preserving unknown-account timing behavior and hash
  strength. A fixed mmap threshold alone does not bound concurrent peak memory.

The initial investigation changed documentation only. The follow-up below applies
the setting to the standalone image. The existing production deployment is unchanged.

## Implemented in the standalone image — 2026-11-17

Dockerfile.rust now sets `MALLOC_MMAP_THRESHOLD_=131072` in the final runtime stage.
No Compose override is needed. No authentication code, hash strength or server
startup flags were changed. This targets the pinned Debian/glibc image; it does not
configure source builds outside that image.

The rebuilt image was tested without an allocator environment override:

| Stage | Docker-style MiB | Process RSS MiB |
| --- | ---: | ---: |
| Existing-account login and history retrieval | 1.96 | 8.20 |
| After 300 synthetic measurements | 4.25 | 10.34 |
| After ten further serial logins | 3.65 | 9.80 |
| After four simultaneous logins | 4.21 | 10.24 |
| Settled | 4.12 | 10.24 |

Peak process RSS during concurrent verification was 85.65 MiB. Working-memory
peaks still occur while hashing; the change releases those buffers afterward.

Fresh Compose setup/login/logout, account/profile persistence across restart,
non-root execution and healthcheck passed. The existing standalone, iSpindel,
BrewPi chamber/SG-profile and Tilt acceptance scripts also passed with their server
processes run from the actual release image: host emulators communicated over
loopback, and only temporary test directories were mounted. All test containers
and temporary databases were removed afterward.

All 43 Rust tests and all 50 desktop/mobile browser tests passed with the same
allocator variable set for their host test processes. Browser acceptance includes
local/external authentication, backup/restore, calibration and equipment workflows.

## Subsequent minimal runtime and authentication hardening

The runtime is now assembled from `scratch` with the required Debian glibc/libgcc
libraries; the allocator setting is retained. Concurrent password work is capped
at two operations and dummy-hash construction is cached. The figures above predate
these changes; a matched follow-up is recorded below. Smaller image size is not a measurement
of lower RAM consumption. See CONTAINER.md and SECURITY_AUDIT.md.

## Matched minimal-image comparison — 2026-11-17

Two runs each used identical copies of a synthetic database (one local account,
one iSpindel and 1,000 initial measurements), 300 new packets, history retrieval,
ten serial logins and four synchronized concurrent login attempts. Collection was
enabled; control and exports were disabled. Containers and databases were disposable.

| Image | Settled process RSS, MiB | Peak process RSS, MiB | Concurrent login responses |
| --- | ---: | ---: | --- |
| Previous standalone, allocator tuned | 10.01–10.16 | 85.54–85.58 | Four HTTP 200 |
| Hardened app, Debian slim | 9.88–10.67 | 47.38–48.18 | Two HTTP 200, two HTTP 429 |
| Hardened app, scratch | 9.91–10.38 | 47.47–47.99 | Two HTTP 200, two HTTP 429 |

The minimal image showed no meaningful steady-state RAM reduction. The lower
concurrent peak comes from limiting password hashing to two operations, not from
removing unused files. Excess attempts are rejected for retry rather than queued;
the peak comparison therefore does not represent four simultaneously completed
password checks in the hardened app. Password strength/work factors are unchanged.

Scratch Docker-style usage settled at 3.79–4.25 MiB. The previous image measured
9.99 MiB on its first run but 4.04 MiB on its second despite near-identical process
RSS. This is consistent with shared file/page-cache charging differences between
cgroups; process RSS and anonymous RSS provide the more useful version comparison.
No caches were flushed and production services were not modified. Two short runs
are not a long-duration leak test or a guaranteed peak-memory bound.

Sanitized stage measurements and exact image IDs are retained in
[memory-comparison.json](memory-comparison.json).

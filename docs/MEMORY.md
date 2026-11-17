# Memory investigation — 2026-11-17

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

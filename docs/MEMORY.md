# Memory usage

YeastCraft is designed for a modest fermentation server. Here is what we measured, what
those numbers mean, and where they stop being useful.

## Standalone runtime

Measured on Linux x86_64 on 2026-11-17 using the minimal Docker runtime, its shipped
glibc allocator setting and the two-operation password-hashing limit:

| Measurement                                       |  Observed range |
| ------------------------------------------------- | --------------: |
| Settled process RSS                               |  9.91–10.38 MiB |
| Settled Docker-style usage                        |   3.79–4.25 MiB |
| Peak process RSS during concurrent login attempts | 47.47–47.99 MiB |

Two runs used identical copies of a synthetic SQLite database with one local
account, one iSpindel and 1,000 measurements. Each run added 300 packets, retrieved
history, performed ten serial logins and attempted four simultaneous logins.
Collection was enabled; control and exports were disabled. Two simultaneous logins
succeeded; the other two received HTTP 429 and must retry. Containers and test
databases were disposable. Caches were not flushed.

Docker-style usage here means cgroup v2 `memory.current` minus `inactive_file`.
Process RSS was read from `/proc`. Shared pages and cache accounting explain why
these figures differ. Browser memory and external services are excluded. These
are short measurements, not a guaranteed minimum, maximum or long-duration leak test.

Machine-readable observations and image IDs are retained in
[memory-comparison.json](memory-comparison.json). The standalone scratch entries
are the basis for the table; other entries are comparison controls, not shipped
product variants.

## Our experience replacing Fermentrack

Our original Fermentrack installation used approximately **490 MiB** in Docker
snapshots. YeastCraft has been substantially lighter in that installation, but we did not
run a matched original-versus-YeastCraft benchmark. Hardware coverage, features, data,
authentication and workload affect the comparison; no universal reduction ratio
or full feature parity is claimed.

The architecture matters alongside Rust. One process handles the API, collection
and profiles, with SQLite for storage. Separate Python workers, Redis and a Node
server are not required. Charts run in the browser.

## Why sign-ins use extra memory

Password hashing intentionally needs working memory. The runtime caps concurrent
hash operations at two and sets `MALLOC_MMAP_THRESHOLD_=131072` so glibc can return
large temporary buffers after use. Hash strength is unchanged. Source builds
outside the image do not automatically inherit that environment setting.

A smaller container download is not evidence of lower RAM use. Likewise, an idle
snapshot does not predict memory needed for imports, backups, large histories or
concurrent requests. Leave headroom and observe your own workload.

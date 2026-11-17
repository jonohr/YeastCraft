# Runtime advisory applicability — 2026-11-17

All 33 unique CVEs behind the 40 package/advisory pairs were checked against
Debian's security tracker. The same pairs recur on all three architectures. The
per-CVE decision, rationale and primary-source link are in `runtime-triage.json`.
No scanner finding has been hidden or suppressed.

Evidence: source review, exact image file inventory, retained package metadata,
ELF dependency/import tables for all three binaries, and upstream/Debian descriptions.
The three `*-imported-symbols.txt` files record the imported interfaces. Absence of
a direct import alone is not proof about all indirect library behavior; decisions
also consider the required input, runtime components and privilege context.

| Assessment | Unique CVEs | Meaning |
| --- | ---: | --- |
| Component absent | 8 | C++ library, compiler demangler tools or nscd not shipped |
| No app call path found | 14 | Affected libc APIs not imported; no corresponding app operation found |
| Required runtime conditions absent | 5 | Missing conversion modules/catalogs or privileged loader context |
| Different architecture | 1 | Power8-specific implementation, not any supported image architecture |
| Conditional defense-in-depth | 4 | Disputed standalone impact or prerequisite exploit/executable execution |
| Deployment-dependent risk remains open | 1 | DNS resolver can abort on an overlong configured search domain |

## Open availability risk: CVE-2026-8674

RS imports `getaddrinfo` and `__res_init`, so this is a real relevant interface.
A search domain of roughly 200 characters or more in `/etc/resolv.conf` or
`LOCALDOMAIN` can cause a glibc assertion failure. DHCP/VPN configuration can feed
such values into a host. This is not triggered by an ordinary sensor HTTP payload.
[Debian's advisory](https://security-tracker.debian.org/tracker/CVE-2026-8674) reports
a postponed fix for bookworm; no patched bookworm package was available in the scan.

Use trusted DNS/DHCP/VPN configuration and validate search domains. On deployments
using only fully qualified controller/export names or IP addresses, an explicit
Compose `dns_search: ["."]` avoids inheriting search suffixes. It changes short-name
resolution, so this is an operator choice rather than a silent default change.
Do not pass an untrusted LOCALDOMAIN environment value. Rebuild when Debian ships
a fix. The current Compose restart policy is `no`, so a crash would require an
operator restart; do not describe this as automatically recovered.

The four conditional defense-in-depth advisories remain tracked, not dismissed as
proof of memory safety. A different app feature, added C/C++ library, shell, locale
bundle, setuid executable or different DNS configuration requires reassessment.

Conclusion: no directly HTTP-triggerable runtime vulnerability was identified in
this review. There is still a deployment-dependent denial-of-service risk, and this
is not a penetration test or proof that the application has no vulnerabilities.
A documented early preview is reasonable; a zero-risk/zero-CVE claim is not.

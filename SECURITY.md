# Security

Fermentrack RS is an early preview. The current security review is documented in
[the audit report](docs/SECURITY_AUDIT.md); it is not an independent penetration test.

Use the latest reviewed source and rebuild images for dependency/security updates.
No stable release or long-term security support schedule has been established yet.

## Deployment boundary

- Complete first-account setup on a trusted network. The default Docker port is
  reachable on all IPv4 host interfaces; optional loopback binding is documented.
  Do not expose an unconfigured installation to untrusted users.
- Use HTTPS for remote access and enable secure cookies as described in [installation](docs/INSTALLATION.md).
- Local accounts have full administrative access; this is not a multi-tenant service.
- External authentication requires a trusted proxy and its separate proof secret.
  Do not expose a bypass around that proxy.
- Sensor tokens authorize ingestion. Keep them and their receiving URLs private;
  rotate a token if it leaks. Legacy devices may require a trusted local network.
- Backups contain private measurements and may contain integration credentials.
  Store them as secrets even though user/session tables are excluded from exports.
- Keep controller and export destinations under the administrator's control.
  Outbound access is not an untrusted-user URL-fetching service.

## Reporting

Do not publish exploit details, tokens, databases or private network addresses in
an issue. Private vulnerability reporting has not yet been verified for this
repository. Until that route is available, use an existing private channel to the
repository owner. Do not put sensitive details into a public issue to ask how to
report them. A verified private reporting route is required before public release.

## Reproducing the scans

After building the standalone image, run:

```sh
scripts/security-audit.sh /tmp/fermentrack-audit fermentrack-rs:local
npm --prefix ui audit
```

The script pins Trivy, scans locked source dependencies (including development
packages), secrets and supported Docker misconfigurations, then the runtime image.
It writes JSON reports outside the checkout. Exit zero means the scan completed;
it does not mean zero findings. Review severities, applicability and fixed versions.
Rust unit/security tests and browser tests are described in CONTRIBUTING.md.

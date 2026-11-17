# Security

Fermentrack RS is an early preview. The current security review is documented in
[the audit report](docs/SECURITY_AUDIT.md); it is not an independent penetration test.

Use the latest reviewed source and rebuild images for dependency/security updates.
No stable release or long-term security support schedule has been established yet.

## Deployment boundary

- Complete first-account setup through loopback/SSH before exposing the service.
- Use HTTPS for remote access and enable secure cookies as described in INSTALLATION.md.
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
an issue. Once a public GitHub repository exists and private vulnerability reporting
is enabled, use its private security advisory flow. Until then, contact the repository
owner through an existing private channel. There is no public reporting endpoint yet.

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

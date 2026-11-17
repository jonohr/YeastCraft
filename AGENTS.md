# Fermentrack RS

Read README.md and docs/COMPATIBILITY.md before changing behavior. New code is
GPL-3.0-only. Preserve NOTICE.md, upstream attribution and license notices.

Develop and verify desktop and mobile together. Use synthetic fixtures and the
standalone emulators; never connect tests to physical controllers or external
export destinations. Keep a single application in control of a device. Preserve
confirmed-command handling, restart behavior and restoration safety.

Do not commit runtime databases, secrets, private histories, node_modules or build
output. Run relevant Rust/browser tests and update the affected documentation.
Public publication, package releases and hardware commands require explicit scope.

# Installation and operations

## First start

Use the Docker Compose command in README.md. Create the administrator account before
exposing the app to other machines. Local authentication is the default. First-run
setup and login must work without any reverse proxy or external identity provider.

Compose builds the source locally; there is no published image registry requirement.
The minimal runtime supports amd64, ARM64 and ARMv7 (ARM Docker verified under emulation; ARM64 app also tested natively on Pi 5).
It has no shell or package manager. See [container details](CONTAINER.md).
`docker compose -f compose.rust.yml down` stops the installation but keeps its named
database volume. Do not add `-v` unless you intend to delete that installation's data.

## Enable collection and temperature control

Create `compose.control.yml` beside `compose.rust.yml`:

```yaml
services:
  fermentrack-rs:
    command:
      - --listen
      - 0.0.0.0:8315
      - --enable-collection
      - --enable-control
```

Then recreate the service with both files:

```sh
docker compose -f compose.rust.yml -f compose.control.yml up -d
```

Stop the old application before connecting the same BrewPi. In **Equipment**, add
a temperature controller, choose TCP or serial, and enter its address/port or serial
path. TCP controllers must be reachable from the container. `127.0.0.1` inside a
container refers to the container, not the host. Serial devices need an explicit
Compose `devices:` mapping and appropriate permissions; physical USB support has
not been verified across boards. Do not use privileged mode as a shortcut.

The connection workflow waits for a fresh reading. Choose **Change target** or
start a profile to control temperature. Check the returned target and controller
state. A manual target cancels the assigned profile. Hardware still regulates its
own heating/cooling cycle; RS sends targets and logs measurements.

For an iSpindel, enable collection, create its sensor and receiving token, and point
the device at `/iSpindel` on the reachable app URL. Choose device SG/Plato explicitly
or configure the server calibration. A human-login reverse proxy must provide a
separate reachable ingest path for sensors; do not disable authentication for the
whole application. The sensor token authenticates ingest requests.

Exports additionally require `--enable-export` and an explicitly enabled destination.
They remain off by default. Do not use a real destination for test payloads.

## Network access and authentication

The bundled Compose file publishes only `127.0.0.1:8315`. SSH forwarding supports
remote initial setup without changing that exposure. For shared access, configure
an HTTPS reverse proxy and use `--secure-cookie`. Proxy forwarding must preserve
the external Host/Origin consistently; cross-origin writes are refused.

Local login can stay enabled behind a proxy. Optional proxy-only authentication
uses `--disable-internal-auth --proxy-proof-file /run/secrets/proxy-proof`.
The proof file must contain64 hexadecimal characters. The proxy must authenticate
the user, overwrite `X-Fermentrack-Proxy-Proof` with that secret and prevent direct
untrusted access to the upstream. Merely sending identity headers is insufficient.
Store proof files outside source control. The optional external logout path currently
uses Authentik's `/outpost.goauthentik.io/sign_out`; other providers need adaptation.
No proxy-only mode is needed for the default standalone installation.

## Backup, restore and import

Download the SQLite backup from the app before upgrades. It excludes login accounts
and sessions, so preserve administrator access separately. Restore requires reviewing
the file and explicit confirmation, with collection/control/exports disabled on the
server. Restored equipment and destinations remain disabled until reconnected.

For legacy import, keep a consistent SQLite database copy and stable CSV directory
under ignored `private-import/`. Import never requires a running Django installation:

```sh
rust/target/debug/fermentrack-rs import --db state/fermentrack.sqlite \
  --source private-import/source.sqlite --data private-import/data
# Review the report; append --apply only when ready.
```

Imported equipment and exports start disabled. Keep the source backup; unsupported
or inconsistent data are reported. A full import parity tool is available as
`scripts/verify-legacy.py` for your own private SQLite/CSV copies.

## Raw BrewPi log

Open a controller and expand **BrewPi raw log**. RX is received, TX is sent, and
ERROR records exchange failures. Reading the log sends no hardware commands.
It shows at most 200 lines per controller from a shared 500-line memory buffer;
long lines are truncated at 2048 characters and marked. The buffer clears on restart.

## Updates and rollback

Build the intended source revision and recreate the same Compose project without
removing its volumes. Keep a backup and the previous image. Verify fresh readings,
controller mode and target after updates. Do not restore an older database merely
to roll back an interface change. Future schema changes may need a documented
migration procedure; this preview does not promise arbitrary version downgrade support.

## Runtime memory

The standalone image sets `MALLOC_MMAP_THRESHOLD_=131072` for its glibc allocator,
so large temporary password-hashing buffers can be returned to the operating
system after use. Password hashing strength is unchanged. Concurrent sign-ins still
need temporary working memory; this is not a guarantee of a fixed maximum usage.
See [memory verification](MEMORY.md) for measured values and methodology.

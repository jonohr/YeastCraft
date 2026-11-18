# From first start to first fermentation

This guide gets YeastCraft talking to your equipment, then covers the everyday jobs:
backups, updates and figuring out what the controller just said.

## First start

Use the [Docker Compose quick start](../README.md#quick-start-with-docker-compose). Open `http://SERVER-IP:8315` on
your trusted local network and create the administrator account. Local authentication is the default. First-run
setup and login work without a reverse proxy or external identity provider.

Compose builds the source locally; there is no published image registry requirement.
The minimal runtime supports amd64, ARM64 and ARMv7 (ARM Docker verified under emulation; ARM64 app also tested natively on Pi 5).
It has no shell or package manager. See [container details](CONTAINER.md).
`docker compose -f compose.rust.yml down` stops the installation but keeps its named
database volume. Do not add `-v` unless you intend to delete that installation's data.

## Connect equipment and control temperature

Collection, control and export workers are available by default. Configure equipment
and destinations in the app; there is no second activation step in Compose.

Stop the old application before connecting the same BrewPi. In **Equipment**, add
a temperature controller, choose TCP or serial, and enter its address/port or serial
path. TCP controllers must be reachable from the container. `127.0.0.1` inside a
container refers to the container, not the host. Serial devices need an explicit
Compose `devices:` mapping and appropriate permissions; physical USB support has
not been verified across boards. Do not use privileged mode as a shortcut.

The connection workflow waits for a fresh reading. Choose **Change target** or
start a profile to control temperature. Check the returned target and controller
state. A manual target cancels the assigned profile. Hardware still regulates its
own heating/cooling cycle; YeastCraft sends targets and logs measurements.

For an iSpindel, create its sensor and receiving token, and point
the device at `/iSpindel` on the reachable app URL. Choose device SG/Plato explicitly
or configure the server calibration. A human-login reverse proxy must provide a
separate reachable ingest path for sensors; do not disable authentication for the
whole application. The sensor token authenticates ingest requests.

For exports, configure and explicitly enable a destination in the app. Nothing is
sent before a destination is configured and enabled. For Brewfather, the sender
is **YeastCraft** and the device name is the selected controller or sensor name.
Keep that name stable between batches; associate the device with your batch in
Brewfather. Synthetic test readings belong in a separate, deliberately chosen test
device, not your fermentation history. [Brewfather test evidence](VALIDATION.md#brewfather-delivery).

Choose **Brewfather** in the two-step batch-start flow to use a batch's measured
OG and fermentation plan. Connect there or under Settings → Integrations.
YC starts a new local fermentation; historical data and measurement
synchronization are not imported. See [setup and limits](BREWFATHER.md).

## Network access and authentication

The bundled Compose file publishes port 8315 on all IPv4 host interfaces by default.
This makes it reachable from other computers and sensors on your network. Binding
to all interfaces is not a firewall: use a trusted network and do not forward this
HTTP port directly from the internet. Complete first-account setup promptly.

For a local proxy or SSH-only access, create a `.env` file beside Compose containing:

```dotenv
YEASTCRAFT_BIND_ADDRESS=127.0.0.1
```

Recreate the container after changing the bind address. You can also set it to a
specific address assigned to the host. For SSH forwarding:

```sh
ssh -L 8315:127.0.0.1:8315 user@your-server
```

For HTTPS, configure a reverse proxy and add `--secure-cookie` to the server
command. Proxy forwarding must preserve the external Host/Origin consistently;
cross-origin writes are refused. Do not enable secure cookies for plain HTTP.

Local login can stay enabled behind a proxy. Optional proxy-only authentication
uses `--disable-internal-auth --proxy-proof-file /run/secrets/proxy-proof`.
The proof file must contain 64 hexadecimal characters. The proxy must authenticate
the user, overwrite `X-YeastCraft-Proxy-Proof` with that secret and prevent direct
untrusted access to the upstream. Merely sending identity headers is insufficient.
Store proof files outside source control. The optional external logout path currently
uses Authentik's `/outpost.goauthentik.io/sign_out`; other providers need adaptation.
No proxy-only mode is needed for the default standalone installation.

## Backup, restore and import

Download the SQLite backup from the app before upgrades. It excludes login accounts
and sessions, so preserve administrator access separately. Restore requires reviewing
the file and explicit confirmation. Start the server with `--maintenance` while
restoring; this explicitly suspends collection, control and exports. For Docker,
create a temporary override such as `compose.maintenance.yml`:

```yaml
services:
  yeastcraft:
    command: ["--listen", "0.0.0.0:8315", "--maintenance"]
```

Run `docker compose -f compose.rust.yml -f compose.maintenance.yml up -d`, restore
the backup in the app, then run `docker compose -f compose.rust.yml up -d` to return
to normal operation. Restored equipment and destinations remain disabled until
reconnected. Individual `--disable-collection`, `--disable-control` and
`--disable-export` switches are also available for diagnostic use. The former
`--enable-*` switches remain accepted for existing launch configurations, but are
not needed. Conflicting enable/disable options are rejected.

For legacy import, keep a consistent SQLite database copy and stable CSV directory
under ignored `private-import/`. Import never requires a running Django installation:

```sh
rust/target/debug/yeastcraft import --db state/yeastcraft.sqlite \
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

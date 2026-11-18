# Brewfather batch preview

Open **Settings → Integrations → Browse Brewfather batches** to read a batch's
OG/FG, readings and fermentation plan. The preview runs inside YeastCraft's Rust
server, with the same authentication as other application APIs. No Python or
additional service is needed.

Choose a batch, then review **How YC would run this batch**. The timeline starts
at day zero for a new fermentation. Holds and ramps have separate durations;
a Brewfather ramp adds time before its hold. The final-temperature selector
previews either keeping the final target or switching temperature control off.
Changing it makes no server write.

An initial ramp has no previous target to start from: YeastCraft omits it,
sets the first target immediately and keeps the specified hold duration. This
adjustment is displayed. Pressure settings are excluded with a notice.
Zero-duration steps without a usable ramp require review. The candidate targets
beer temperature. Hold time starts on step entry, not when the liquid reaches
the setpoint. Gravity conditions are not inferred from timed Brewfather steps.

This first integration is read-only. It does not create a YC batch/profile,
start equipment, synchronize readings or import historical batches. Charts
show the readings returned by Brewfather for inspection only; full historical
coverage is not assumed. The existing **Brewfather export** remains separate.

## Connect your account

Open **Settings → Integrations → Brewfather connection**. Enter your User ID
and an API key with **batches.read** access, then choose **Connect Brewfather**.
YC tests access before saving. A failed replacement preserves the previous
connection. **Test connection** rechecks the stored credentials. **Disconnect**
removes the connection and clears cached account data without changing local
batches or temperature control.

The API key input is masked and never prefilled from the server. No credential
values are returned by the status, save or test APIs, or stored in browser local
storage. TLS must protect remote access. The reusable connection form is ready
for the planned batch-start flow; that flow remains a separate design change.

## Encryption and recovery

Both User ID and API key are encrypted with AES-256-GCM (ring), a fresh random
96-bit nonce and versioned associated data before insertion into the dedicated
SQLite `service_credentials` table. The 256-bit encryption key is a separate
owner-only file; it is never in SQLite. By default its path is the database path
with extension `.credentials.key`, created atomically on the first successful
connection. The normal writable state volume therefore persists it across
container recreation. Do not delete this file while retaining the database.

For a separately managed key, set `YEASTCRAFT_CREDENTIAL_KEY_FILE` to a mounted
file containing exactly32 random bytes, readable by the runtime user and mode600.
The previous plaintext `YEASTCRAFT_BREWFATHER_CREDENTIALS_FILE` is no longer read.
Do not paste credentials or encryption keys into issues or tracked config.

Application JSON/SQLite exports omit the connection and its key; restoring
application data keeps the destination's connection unchanged. Full host/database
backups contain encrypted credentials and need the corresponding key to unlock
them. Back up the key separately in private recovery storage. A missing or wrong
key fails closed; YC does not silently replace it. Restore the correct key, or
disconnect and connect again. Restart clears caches after manual recovery.

Encryption protects a copied database without its key. It does not protect
against someone who controls the running server and can read both. Previously
created host backups may still contain the former plaintext credential file.

## Request and memory limits

Requests happen when browsing or refreshing, without background polling. Batch
lists are cached for five minutes, selected data for one minute. Upstream GETs
are limited to 100 per hour per process. HTTP failures trigger a cooldown, with
Retry-After honored up to one day. Redirects are refused; only fixed Brewfather
batch endpoints are used. Credentials and upstream error bodies are never
returned to the browser. Cached response bodies total at most 16 MB, with at
most 16 entries and a 12 MB per-response limit. Parsed data and browser memory
are additional temporary costs. No changes to controller scheduling are made.

## Validation

Synthetic tests cover translation boundaries against YC's actual profile
engine, initial ramps, pressure omission, missing/invalid/zero durations,
fractional and ramp-only steps, final hold/off, data projection, readings,
cache and request limits. Route tests enforce login, cursor validation and
GET-only access. Mobile/desktop browser tests cover connection errors, batch
selection, notices, timeline and final behavior without writes. Tests never use
an account or physical controller. Real-account acceptance is a separate local
deployment check.

# Brewfather connection and batch start

Choose **Add** under Batches (or **New batch** on Overview), then choose
**Manual**, **YC profile**, or **Brewfather**. This is one two-step flow:
choose a temperature plan, then review the batch and equipment before starting.

Brewfather shows recent batches as cards, newest brew date first. **Show more
batches** reveals older entries. Selecting one reads its name, measured OG and
fermentation profile; missing OG stays blank. The review lets you edit the name
and OG, choose equipment and choose whether to hold the final temperature or
switch control off. Invalid profiles require another choice or a local YC plan.

No history is imported in this flow and no Brewfather batch is modified. YC
starts a new local fermentation from the first step. **Save draft** preserves
the selected plan, OG and equipment without assigning a profile or sending a
command. Reopening the draft retains the choice. **Start batch** makes a local
copy of a Brewfather profile and assigns it using YC's existing profile engine.
A running schedule does not need continued access to Brewfather. This is not
bidirectional synchronization; the existing **Brewfather export** is separate.

Holds and ramps have separate durations: a Brewfather ramp adds time before its
hold. The review shows the resulting curve and expandable steps. An initial
ramp has no previous target: YC omits it with notice, sets the first target and
keeps its hold time. Pressure is excluded with notice. Zero-duration steps
without a usable ramp need review. Translated profiles target beer temperature
in Celsius; the controller engine converts to the configured controller unit.
Hold time starts on step entry, not when the liquid reaches the target. Gravity
conditions are not inferred from timed Brewfather steps.

Starting validates controller readiness and active-batch conflicts. A failed
command leaves a planned batch for retry. If profile assignment succeeds but
saving active status fails, retry completes that batch without reassigning the
profile. Reopening also detects the same saved profile already assigned to the
chosen controller. A different assigned profile requires manual review.

The older diagnostic preview remains available directly at `/brewfather/`; it
can inspect readings, but it is no longer the entry point in Settings. It is
separate from starting batches and makes no control changes.

## Manual gravity readings

For an active batch started from Brewfather, YC checks for manual SG readings
at startup when due and every 15 minutes thereafter. The batch page shows the
latest manual SG, its original measurement time, last successful sync and errors.
**Sync readings** checks immediately (at most once per minute). Collection must
be enabled. No new API permission or separate sensor is needed to show readings.

Only explicitly manual readings dated between the YC batch's start and now are
copied. Automatic device readings and earlier history are ignored. The readings
stay with that batch, retain their original timestamps and are labelled
**Manual · Brewfather**. Repeated fetches and restarts do not duplicate them.
Edits update the matching timestamp. When a complete response no longer contains
an imported reading, YC removes that imported copy; local measurements remain.
Responses of 5000 or more points are treated as potentially truncated: missing
older points are retained and a warning appears. Network failures or malformed
responses retain the previous data and report a sync error.

Manual SG conditions can use these readings when the running profile selects
**Manual** readings and the same gravity sensor as the active batch on that
controller. Readings from other batches do not count. Existing freshness and
stability rules still apply; a single iSpindel packet is not a manual measurement.
The sensor selection associates the condition with the batch; imported samples
are not added to the sensor's reusable history or calibration references.
A later correction cannot undo a profile step already confirmed by the controller.

Finishing a batch stops polling; saved readings remain. Disconnecting Brewfather
stops upstream requests without stopping the local temperature profile. This
connection only reads Brewfather: it does not change OG, FG, the running plan,
or send imported values back. Outbound Custom Stream exports remain separate.


## Connect your account

Open **Settings → Integrations → Brewfather connection**. Enter your User ID
and an API key with **batches.read** access, then choose **Connect Brewfather**.
YC tests access before saving. A failed replacement preserves the previous
connection. **Test connection** rechecks the stored credentials. **Disconnect**
removes the connection and clears cached account data without changing local
batches or temperature control.

The API key input is masked and never prefilled from the server. No credential
values are returned by the status, save or test APIs, or stored in browser local
storage. TLS must protect remote access. If no connection exists when choosing
Brewfather during batch start, the same connection form appears there without
leaving the flow. Cancel returns to Manual.

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

Browsing and preview requests happen on demand. Active linked batches also poll
readings every 15 minutes; the background worker shares the same request budget,
cache and cooldown as interactive requests.
The start-plan endpoint fetches only the batch/profile, never readings. Lists
use Brewfather's documented descending brewDate ordering and pagination
([API documentation](https://docs.brewfather.app/api)). Batch
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
selection, draft restoration, unit conversion, final behavior and recovery after
a failed batch activation without repeated profile assignment. Tests never use
an account or physical controller. Real-account acceptance is a separate local
deployment check.

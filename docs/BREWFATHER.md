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

## Server credentials

Create a private file outside the repository with these two entries:

```ini
BREWFATHER_USER_ID=your-user-id
BREWFATHER_API_KEY=your-api-key
```

Use a Brewfather API key with **batches.read** permission. Set the host file to
owner-only access and mount it read-only, readable by the container user (UID
1000 in the shipped image). Add this to a local Compose override:

```yaml
services:
  yeastcraft:
    environment:
      YEASTCRAFT_BREWFATHER_CREDENTIALS_FILE: /run/secrets/brewfather.env
    volumes:
      - /absolute/private/path/brewfather.env:/run/secrets/brewfather.env:ro
```

Recreate the container after adding the mount/environment. Never paste keys into
an issue, the browser, or a tracked Compose file. Without this setting, the page
explains that Brewfather is not connected; other YC functionality is unaffected.
The file is read server-side and is not included in database backups. Include it
in your private secret recovery process. Restart YC after rotating credentials
to clear cached data from the previous connection.

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

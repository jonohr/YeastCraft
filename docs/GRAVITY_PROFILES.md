# Gravity-controlled fermentation profiles

Sometimes the yeast does not follow the calendar. Gravity conditions let a profile
wait for measurements before changing temperature. The controller still regulates
temperature; YeastCraft changes its target when the current step finishes.

## Create a profile

1. Open **Profiles → Add**. Choose beer or chamber temperature as usual.
2. Set the first step's target, for example **18 °C**.
3. Under **Move to next step** (or **Finish this step** for the last step), choose:
   - **After a duration**: timed Hold/Ramp behavior.
   - **When SG reaches a value**: hold until SG is at or below the threshold.
   - **When SG stays stable**: hold until measurements span the specified hours
     with maximum minus minimum SG within the specified range (default 0.001 SG,
     editable under **Advanced**).
4. In the same step card, choose **Manual measurements** or **iSpindel**, then
   the gravity sensor containing those readings. A manual measurement can be
   recorded against an iSpindel sensor; automatic values are ignored in manual mode.
5. Add the next step with the new target, for example **21 °C**. Repeat as needed.
6. Save, review and start the profile on the intended controller. Saving a template
   never starts control. The review/start action enables the selected profile;
   there is no separate controller-ownership checkbox.

Example: hold 18 °C until SG≤1.020, hold 21 °C until SG is stable for 48 hours,
then ramp to 7 °C over 24 hours. Completion retains the final target or turns control
off, according to the explicit choice. Gravity steps use Hold; a following Ramp
uses its configured duration. The preview shows step order rather than a fictional
completion date when gravity conditions make the duration unknown.

## Reading rules

- A **single new manual reading** can satisfy the SG threshold. Stability requires
  at least two readings whose timestamps cover the period. The latest manual
  reading must be no older than 24 hours when evaluated.
- **iSpindel requires at least three distinct measurement times spanning at least
  ten minutes**. Every value in the confirming interval must satisfy the condition.
  Stability also requires coverage of the full selected duration. The newest value
  must be at most 30 minutes old; a gap over 30 minutes resets confirmation.
- Automatic control uses the SG calculation selected for that sensor (device SG
  or YeastCraft calibration). Invalid/missing SG and changes in calibration ID or
  SG source break the confirming series. Old values from a previous calculation
  do not trigger a transition before new values from the active calculation arrive.
- Only readings **after the current step started** are eligible. Preexisting
  readings and observations used by the preceding step cannot immediately trigger
  another step. Duplicate timestamps do not count as independent observations.
- Missing/stale/insufficient readings keep the current target and show the profile
  waiting. There is no automatic time-based fallback. Evaluation occurs on the
  existing collector cycle (normally 30 seconds), not synchronously in the form save.
- Stability is a measurement condition, not a guarantee of fermentation completion.

For now, automatic SG conditions require the iSpindel freshness and confirmation
windows above. A sensor waking only once an hour can still log readings, but will
not satisfy those automatic conditions. Battery-friendly intervals and Brewfather
manual-reading import are part of the [planned integration work](https://github.com/jonohr/fermentrack-rs/issues/1).

## Persistence and visibility

Conditional profiles snapshot their template when assigned. Editing the template
changes future runs; start it again deliberately to replace an active run. The
current step, entry time, confirmation evidence and desired target survive restart.
A new step cannot advance again until the firmware confirms its target. Failed
commands retry the persisted target without skipping the step. Step transitions
are recorded in the audit table; the controller page shows the latest SG evidence
and measurement time, current/upcoming/completed steps and waiting status.

Scheduled starts, manual-target cancellation, explicit profile stop and completion
Off are supported. Restore still disables collection/control;
restored profiles do not gain ownership automatically. Time-only profiles use their configured durations. No additional runtime service
is needed. Confirmation reads are bounded to the latest 10,000 eligible
observations; exceptionally high-rate/long-window data that cannot prove coverage
within that bound keeps waiting rather than assuming stability.

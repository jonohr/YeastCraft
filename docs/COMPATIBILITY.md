# Compatibility and evidence

This is an early preview, not a claim of full Fermentrack feature parity.

| Area | Evidence | Remaining limits |
| --- | --- | --- |
| BrewPi TCP | Physical ESP8266 firmware 0.2.4: readings, reconnect, unit checks, setpoints and readback | Other boards/firmware need testing |
| Pins/probes | Physical GPIO assignment and OneWire edit/remove/install checked on that controller | Wider hardware combinations not verified |
| Serial | Implemented with exclusive open and protocol tests | USB hardware/reset behavior not physically verified |
| Timed profiles | Hold/Ramp, scheduling and restart/readback checks, including physical controller trials | No universal thermal-performance claim |
| Gravity conditions | Threshold/stability, manual/iSpindel separation, persistence and TCP setpoints tested with emulators | Not validated through a complete real fermentation |
| iSpindel | HTTP ingest, angle/device/server SG, manual references and calibration tests | Simulator acceptance is not complete physical-device certification |
| Tilt/BLE/TiltBridge | Not implemented | Hardware contributors welcome |
| Firmware tools | Not implemented | Flash with existing tools; no firmware binaries included |
| Exports | Adapter/payload and isolated HTTP tests | Delivery to each external production service not verified |
| Import/backup | SQLite/CSV fixtures, private legacy parity checks and backup/restore tests | Review warnings; unsupported legacy features remain |
| Platforms | Linux x86_64 development/runtime testing | ARM images and other operating systems not verified |

The original controller firmware controls heating/cooling cycles. Neither a
simulated chamber nor an empty-fridge test predicts the thermal response of beer.
One application must own the controller connection. Operation locks in RS do not
detect a second application using a Wi-Fi controller.

Known limitations include missing discovery, advanced controller constants,
firmware flashing, complete legacy API parity and profile interchange. The current
Delete action is generic: history/references prevent deletion, but an empty active
batch can still be deleted without stopping controller control. Use **Finish batch**
and its explicit temperature choice, then archive completed batches. This UX gap
remains open; deletion must not be interpreted as stopping temperature control.

Contributors should report exact board, firmware version, transport and observed
results. Remove tokens, real histories and private addresses from attached logs.

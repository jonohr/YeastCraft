# Compatibility and evidence

This is an early preview, not a claim of full Fermentrack feature parity.

| Area                                         | Evidence                                                                                                                                   | Remaining limits                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| BrewPi TCP                                   | Physical ESP8266 firmware 0.2.4: readings, reconnect, unit checks, setpoints and readback                                                  | Other boards/firmware need testing                                                                                    |
| Pins/probes                                  | Physical GPIO assignment and OneWire edit/remove/install checked on that controller                                                        | Wider hardware combinations not verified                                                                              |
| Serial                                       | Implemented with exclusive open and protocol tests                                                                                         | USB hardware/reset behavior not physically verified                                                                   |
| Timed profiles                               | Hold/Ramp, scheduling and restart/readback checks, including physical controller trials                                                    | No universal thermal-performance claim                                                                                |
| Gravity conditions                           | Threshold/stability, manual/iSpindel separation, persistence and TCP setpoints tested with emulators                                       | Not validated through a complete real fermentation                                                                    |
| iSpindel                                     | HTTP ingest, angle/device/server SG, manual references and calibration tests                                                               | Simulator acceptance is not complete physical-device certification                                                    |
| Tilt HTTP / legacy TiltBridge                | Experimental form/JSON receivers, protocol fixtures and isolated HTTP tests                                                                | No physical hardware validation; one color per bridge URL; logging only. See [Tilt](TILT.md)                          |
| Direct BLE / TiltBridge 2 Fermentrack target | Not implemented                                                                                                                            | Hardware contributors welcome                                                                                         |
| Firmware tools                               | Not implemented                                                                                                                            | Flash with existing tools; no firmware binaries included                                                              |
| Other export adapters | Payload and isolated HTTP tests | Real-account delivery to services other than Brewfather remains unverified |
| Brewfather batch export | Synthetic HTTP, encryption, persistent intervals, lifecycle and mobile/desktop tests; repeated real temperature delivery and batch API readback after manual attachment | Stable equipment names; live Finish batch with Keep current control verified; extended runtime observation remains pending; other finish choices are automatically tested |
| Brewfather manual SG | Synthetic correction/deletion, persistence and gravity-profile tests; real-account manual readings imported and displayed in YC | Active linked batch only; local YC manual readings are not exported; no edits to upstream OG/FG or profile |
| Import/backup                                | SQLite/CSV fixtures, private legacy parity checks and backup/restore tests                                                                 | Review warnings; unsupported legacy features remain                                                                   |
| Platforms                                    | Linux amd64 native; ARM64 app/libraries native on Raspberry Pi 5; ARM64/ARMv7 Docker under QEMU                                            | Native ARM Docker, physical ARMv7 and other operating systems not verified; see [container builds](CONTAINER.md)      |

The original controller firmware controls heating/cooling cycles. Neither a
simulated chamber nor an empty-fridge test predicts the thermal response of beer.
One application must own the controller connection. Operation locks in YeastCraft do not
detect a second application using a Wi-Fi controller.

Known limitations include missing discovery, advanced controller constants,
firmware flashing, complete legacy API parity and profile interchange. Active batches
cannot be deleted. Use **Finish batch** and its explicit temperature choice, then
archive completed batches. Deletion must not be interpreted as stopping temperature control.

Contributors should report exact board, firmware version, transport and observed
results. Remove tokens, real histories and private addresses from attached logs.

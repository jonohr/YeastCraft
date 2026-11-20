// SPDX-License-Identifier: GPL-3.0-only
//! Conditional profiles use durable step state, never elapsed-time guesses.
use crate::{db, sensors::convert};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

pub fn conditional(p: &Value) -> bool {
    p["steps"]
        .as_array()
        .is_some_and(|s| s.iter().any(|s| s["until"].is_object()))
}
pub fn validate(p: &Value) -> Result<()> {
    if let Some(steps) = p["steps"].as_array() {
        ensure!(
            steps
                .iter()
                .all(|s| s["until"].is_null() || s["until"].is_object()),
            "Invalid gravity condition"
        );
    }
    if !conditional(p) {
        return Ok(());
    }
    ensure!(
        p["gravity_sensor"].as_str().is_some_and(|s| !s.is_empty()),
        "Choose a gravity sensor for the profile"
    );
    ensure!(
        matches!(p["gravity_readings"].as_str(), Some("manual" | "ispindel")),
        "Choose manual or iSpindel readings"
    );
    for s in p["steps"].as_array().context("Missing steps")? {
        if s["until"].is_null() {
            continue;
        }
        ensure!(
            s["transition"] == "hold",
            "Gravity conditions require a Hold step"
        );
        let u = &s["until"];
        match u["kind"].as_str() {
            Some("sg") => ensure!(
                u["sg"].as_f64().is_some_and(|v| (0.5..=2.0).contains(&v)),
                "SG must be between 0.5 and 2.0"
            ),
            Some("stable") => {
                ensure!(
                    u["hours"]
                        .as_f64()
                        .is_some_and(|v| (0.016666666..=8760.).contains(&v)),
                    "Stability duration must be between one minute and one year"
                );
                ensure!(
                    u["tolerance"]
                        .as_f64()
                        .is_some_and(|v| (0.0001..=0.01).contains(&v)),
                    "SG tolerance must be between 0.0001 and 0.0100"
                );
            }
            _ => anyhow::bail!("Unknown gravity condition"),
        }
    }
    Ok(())
}

// Points are newest first. Invalid packets and changes of calibration break the
// confirmation window. Timestamp ties cannot count as independent observations.
fn evidence(rows: &[(i64, Value)], u: &Value, source: &str, now: i64) -> Option<Value> {
    let (latest, first) = rows.first()?;
    if now - latest
        > if source == "manual" {
            86_400_000
        } else {
            1_800_000
        }
    {
        return None;
    }
    let stable = u["kind"] == "stable";
    let span = if stable {
        (u["hours"].as_f64()? * 3_600_000.) as i64
    } else {
        0
    };
    let required_span = if source == "ispindel" {
        span.max(600_000)
    } else {
        span
    };
    let count_needed = if source == "ispindel" {
        3
    } else if stable {
        2
    } else {
        1
    };
    let mut count = 0;
    let mut prev = *latest + 1;
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for (time, v) in rows {
        if *time >= prev {
            continue;
        }
        if source == "ispindel"
            && (prev - time > 1_800_000
                || v["calibration_id"] != first["calibration_id"]
                || v["gravity_source"] != first["gravity_source"])
        {
            break;
        }
        let Some(sg) = v["gravity"].as_f64().filter(|g| (0.5..=2.).contains(g)) else {
            break;
        };
        lo = lo.min(sg);
        hi = hi.max(sg);
        if stable {
            if hi - lo > u["tolerance"].as_f64()? + 1e-10 {
                break;
            }
        } else if sg > u["sg"].as_f64()? {
            break;
        }
        count += 1;
        if count >= count_needed && latest - time >= required_span {
            return Some(
                json!({"reading_source":source,"latest_at":latest,"first_at":time,"sg":first["gravity"],"count":count,"min_sg":lo,"max_sg":hi}),
            );
        }
        prev = *time;
    }
    None
}

pub fn initial(p: &Value, start: i64) -> Value {
    json!({"profile":p,"step":0,"entered":start,"applied":false,"complete":false,"status":"Starting first step"})
}

/// Persist the next desired state before sending it. Retries reapply the same
/// target; no further transition is allowed until firmware confirms this target.
pub fn tick(c: &Connection, d: &mut db::Entity, now: i64, unit: &str) -> Result<(f64, bool)> {
    let mut r = d.data["profile_run"].clone();
    let p = r["profile"].clone();
    validate(&p)?;
    let steps = p["steps"].as_array().context("Missing running profile")?;
    let mut index = r["step"].as_u64().context("Missing running step")? as usize;
    let mut entered = r["entered"].as_i64().context("Missing step start")?;
    let s = steps.get(index).context("Invalid running step")?;
    let mut proof = None;
    let mut ready = false;
    if r["complete"] != true && r["applied"] == true {
        if s["until"].is_object() {
            r["status"] = json!("Waiting for gravity readings to confirm the condition");
            let sensor = db::get(c, p["gravity_sensor"].as_str().unwrap())?;
            ensure!(
                sensor.kind == "sensors",
                "Profile gravity source is not a sensor"
            );
            let source = p["gravity_readings"].as_str().unwrap();
            if source == "manual" || sensor.data["collection_enabled"] == true {
                // Brewfather manual readings belong to the active batch, never to
                // a reusable sensor or another fermentation on that sensor.
                let batches = db::list(c, "batches")?;
                let linked: Vec<_> = batches
                    .iter()
                    .filter(|b| {
                        b.data["status"] == "active"
                            && b.data["device"] == d.id
                            && b.data["sensor"] == sensor.id
                    })
                    .collect();
                let batch_source = if source == "manual" && linked.len() == 1 {
                    linked[0].id.as_str()
                } else {
                    ""
                };
                let mut q = c.prepare("SELECT time,values_json FROM points WHERE (source=?1 OR (source=?5 AND json_extract(values_json,'$.origin')='brewfather')) AND time>?2 AND time<=?3 AND json_extract(values_json,'$.reading_source')=?4 ORDER BY time DESC,sequence DESC LIMIT 10000")?;
                let rows = q
                    .query_map(
                        params![sensor.id, entered, now, source, batch_source],
                        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
                    )?
                    .map(|row| {
                        let (t, v) = row?;
                        Ok((t, serde_json::from_str::<Value>(&v)?))
                    })
                    .collect::<Result<Vec<_>>>()?;
                let current_calculation = source == "manual"
                    || rows.first().is_some_and(|(_, v)| {
                        v["gravity_source"].as_str().unwrap_or("server")
                            == sensor.data["gravity_source"].as_str().unwrap_or("server")
                            && v["calibration_id"] == sensor.data["active_ispindel_calibration"]
                    });
                proof = if current_calculation {
                    evidence(&rows, &s["until"], source, now)
                } else {
                    None
                };
                ready = proof.is_some();
            }
        } else {
            r["status"] = json!("Running timed step");
            ready = now - entered
                >= (s["hours"].as_f64().context("Missing duration")? * 3_600_000.) as i64;
        }
    }
    if ready {
        let transition = json!({"step":index,"at":now,"evidence":proof});
        c.execute(
            "INSERT INTO audit VALUES(?,?,?)",
            params![
                now / 1000,
                "gravity_profile_step",
                json!({"device":d.id,"transition":transition}).to_string()
            ],
        )?;
        r["last_transition"] = transition;
        if index + 1 == steps.len() {
            r["complete"] = json!(true);
            r["status"] = json!("Profile complete");
        } else {
            index += 1;
            entered = now;
            r["step"] = json!(index);
            r["entered"] = json!(entered);
            r["applied"] = json!(false);
            r["status"] = json!("Applying next temperature target");
        }
    }
    let s = &steps[index];
    let mut temp = s["temperature"].as_f64().context("Missing temperature")?;
    if s["transition"] == "ramp" && index > 0 && r["complete"] != true {
        let from = steps[index - 1]["temperature"]
            .as_f64()
            .context("Missing ramp origin")?;
        temp = from
            + (temp - from)
                * ((now - entered) as f64
                    / (s["hours"].as_f64().context("Missing duration")? * 3_600_000.))
                    .clamp(0., 1.);
    }
    let temp = (convert(temp, p["unit"].as_str().unwrap_or("C"), unit)? * 10.).round() / 10.;
    let off = r["complete"] == true && p["end_behavior"] == "off";
    d.data["profile_run"] = r;
    db::put(c, d)?;
    Ok((temp, off))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rows(values: &[(i64, f64)]) -> Vec<(i64, Value)> {
        values
            .iter()
            .map(|(t, g)| (*t, json!({"gravity":g})))
            .collect()
    }
    #[test]
    fn manual_threshold_is_immediate_but_automatic_requires_time_and_count() {
        let u = json!({"kind":"sg","sg":1.020});
        let r = rows(&[(900000, 1.019)]);
        assert!(evidence(&r, &u, "manual", 900000).is_some());
        assert!(evidence(&r, &u, "ispindel", 900000).is_none());
        assert!(
            evidence(
                &rows(&[(900000, 1.019), (899999, 1.019), (899998, 1.019)]),
                &u,
                "ispindel",
                900000
            )
            .is_none()
        );
        assert!(
            evidence(
                &rows(&[(900000, 1.019), (600000, 1.020), (300000, 1.019)]),
                &u,
                "ispindel",
                900000
            )
            .is_some()
        );
        assert!(
            evidence(
                &rows(&[(900000, 1.019), (600000, 1.025), (300000, 1.019)]),
                &u,
                "ispindel",
                900000
            )
            .is_none()
        );
    }
    #[test]
    fn stability_requires_observations_covering_period_and_tolerance() {
        let u = json!({"kind":"stable","hours":48,"tolerance":0.001});
        assert!(evidence(&rows(&[(172800001, 1.012)]), &u, "manual", 172800001).is_none());
        assert!(
            evidence(
                &rows(&[(172800001, 1.012), (1, 1.013)]),
                &u,
                "manual",
                172800001
            )
            .is_some()
        );
        assert!(
            evidence(
                &rows(&[(172800001, 1.012), (1, 1.014)]),
                &u,
                "manual",
                172800001
            )
            .is_none()
        );
        assert!(
            evidence(
                &rows(&[(172800001, 1.012), (1, 1.012)]),
                &u,
                "ispindel",
                172800001
            )
            .is_none()
        );
    }
    #[test]
    fn stale_invalid_duplicate_and_calibration_change_never_confirm() {
        let u = json!({"kind":"sg","sg":1.020});
        let mut r = rows(&[(900000, 1.019), (600000, 1.019), (300000, 1.019)]);
        assert!(evidence(&r, &u, "ispindel", 3000000).is_none());
        r[1].1["gravity"] = Value::Null;
        assert!(evidence(&r, &u, "ispindel", 900000).is_none());
        r[1].1 = json!({"gravity":1.019,"calibration_id":"new"});
        assert!(evidence(&r, &u, "ispindel", 900000).is_none());
        assert!(
            evidence(
                &rows(&[(900000, 1.019), (900000, 1.019), (300000, 1.019)]),
                &u,
                "ispindel",
                900000
            )
            .is_none()
        );
    }
}

#[cfg(test)]
mod runtime_tests {
    use super::*;
    #[test]
    fn durable_cursor_waits_for_ack_and_new_evidence_then_completes_off() {
        let dir = tempfile::tempdir().unwrap();
        let db = db::Db::init(dir.path().join("test.sqlite")).unwrap();
        let c = db.open().unwrap();
        db::put(
            &c,
            &db::Entity {
                id: "s".into(),
                kind: "sensors".into(),
                name: "Manual".into(),
                data: json!({"sensor_type":"manual"}),
            },
        )
        .unwrap();
        let p = json!({"unit":"C","gravity_sensor":"s","gravity_readings":"manual","end_behavior":"off","steps":[
            {"temperature":18,"hours":24,"transition":"hold","until":{"kind":"sg","sg":1.020}},
            {"temperature":21,"hours":0.1,"transition":"hold","until":{"kind":"sg","sg":1.020}}
        ]});
        let mut d = db::Entity {
            id: "d".into(),
            kind: "devices".into(),
            name: "Synthetic".into(),
            data: json!({"profile_run":initial(&p,100)}),
        };
        db::append_point(
            &c,
            "s",
            99,
            &json!({"gravity":1.01,"reading_source":"manual"}),
        )
        .unwrap();
        assert_eq!(tick(&c, &mut d, 200, "C").unwrap(), (18., false));
        d.data["profile_run"]["applied"] = json!(true);
        assert_eq!(tick(&c, &mut d, 300, "C").unwrap(), (18., false)); // old evidence excluded
        db::append_point(
            &c,
            "s",
            400,
            &json!({"gravity":1.019,"reading_source":"manual"}),
        )
        .unwrap();
        assert_eq!(tick(&c, &mut d, 500, "C").unwrap(), (21., false));
        // Simulate command failure/restart: same desired target, no step skipped.
        d = db::get(&c, "d").unwrap();
        assert_eq!(d.data["profile_run"]["applied"], false);
        assert_eq!(tick(&c, &mut d, 600, "C").unwrap(), (21., false));
        d.data["profile_run"]["applied"] = json!(true);
        assert_eq!(tick(&c, &mut d, 700, "C").unwrap(), (21., false)); // cannot reuse old sample
        db::append_point(
            &c,
            "s",
            800,
            &json!({"gravity":1.018,"reading_source":"manual"}),
        )
        .unwrap();
        assert_eq!(tick(&c, &mut d, 900, "C").unwrap(), (21., true));
        assert_eq!(tick(&c, &mut d, 1000, "C").unwrap(), (21., true));
        let count: i64 = c
            .query_row("SELECT COUNT(*) FROM audit", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2); // transitions not repeated by retries
    }
    #[test]
    fn automatic_stability_needs_continuous_coverage() {
        let u = json!({"kind":"stable","hours":1,"tolerance":0.001});
        let mut r: Vec<_> = (0..=12)
            .rev()
            .map(|i| (1 + i * 300000, json!({"gravity":1.012})))
            .collect();
        assert!(super::evidence(&r, &u, "ispindel", 3600001).is_some());
        r[5].1["gravity"] = json!(1.02);
        assert!(super::evidence(&r, &u, "ispindel", 3600001).is_none());
        r[5].1["gravity"] = Value::Null;
        assert!(super::evidence(&r, &u, "ispindel", 3600001).is_none());
    }
    #[test]
    fn rejects_unknown_conditions_sources_and_ramps() {
        let base = json!({"gravity_sensor":"s","gravity_readings":"manual","steps":[{"transition":"hold","until":{"kind":"sg","sg":1.02}}]});
        assert!(validate(&base).is_ok());
        for until in [
            json!(true),
            json!({"kind":"oops"}),
            json!({"kind":"sg","sg":12}),
            json!({"kind":"stable","hours":48,"tolerance":0}),
        ] {
            let mut p = base.clone();
            p["steps"][0]["until"] = until;
            assert!(validate(&p).is_err());
        }
        let mut p = base.clone();
        p["steps"][0]["transition"] = json!("ramp");
        assert!(validate(&p).is_err());
        p = base;
        p["gravity_readings"] = json!("anything");
        assert!(validate(&p).is_err());
    }
}

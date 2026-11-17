// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    ApiError, App, auth,
    db::{self, Entity, Point},
};
use anyhow::{Context, Result};
use axum::{
    Json,
    extract::{Path, State},
};
use serde::Deserialize;
use serde_json::{Value, json};
pub async fn key(State(a): State<App>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let token = uuid::Uuid::new_v4().to_string() + &uuid::Uuid::new_v4().to_string();
    let hashed = auth::digest(&token);
    let kind =
        a.db.run(move |c| {
            let mut e = db::get(c, &id)?;
            anyhow::ensure!(e.kind == "sensors", "Not a sensor");
            e.data["ingest_hash"] = json!(hashed);
            db::put(c, &e)?;
            Ok(e.data["sensor_type"]
                .as_str()
                .unwrap_or("ispindel")
                .to_owned())
        })
        .await?;
    let path = match kind.as_str() {
        "tilt" => format!("/ingest/tilt/{token}"),
        "tiltbridge" => format!("/ingest/tiltbridge/{token}"),
        _ => "/iSpindel".to_owned(),
    };
    Ok(Json(json!({"token":token,"path":path})))
}
pub fn convert(n: f64, from: &str, to: &str) -> Result<f64> {
    match (from, to) {
        ("C", "C") | ("F", "F") => Ok(n),
        ("C", "F") => Ok(n * 9.0 / 5.0 + 32.0),
        ("F", "C") => Ok((n - 32.0) * 5.0 / 9.0),
        _ => anyhow::bail!("Unknown temperature unit"),
    }
}
pub fn plato_to_sg(plato: f64) -> Result<f64> {
    let p = |sg: f64| -616.868 + 1111.14 * sg - 630.272 * sg.powi(2) + 135.997 * sg.powi(3);
    anyhow::ensure!(
        plato.is_finite() && (p(0.5)..=p(2.0)).contains(&plato),
        "Invalid Plato value"
    );
    let (mut lo, mut hi) = (0.5, 2.0);
    for _ in 0..64 {
        let mid = (lo + hi) / 2.0;
        if p(mid) < plato { lo = mid } else { hi = mid }
    }
    Ok((lo + hi) / 2.0)
}
pub fn ispindel_values(packet: &Value, sensor: &Entity, calibrations: &[Entity]) -> Result<Value> {
    let angle = packet["angle"].as_f64().context("Missing numeric angle")?;
    let temperature = packet["temperature"]
        .as_f64()
        .context("Missing numeric temperature")?;
    anyhow::ensure!(
        angle.is_finite() && (0.0..=180.0).contains(&angle),
        "Invalid angle"
    );
    let unit = sensor.data["unit"]
        .as_str()
        .or(sensor.data["temp_format"].as_str())
        .unwrap_or("C");
    let from = packet["temp_units"].as_str().unwrap_or("C");
    let cal = if let Some(active) = sensor.data["active_ispindel_calibration"].as_str() {
        Some(
            calibrations
                .iter()
                .find(|c| {
                    c.id == active && c.data["sensor"] == sensor.id && c.data["enabled"] == true
                })
                .context("Den aktiva iSpindel-kalibreringen saknas")?,
        )
    } else {
        calibrations.iter().find(|c| {
            c.data["sensor"] == sensor.id
                && c.data["legacy_table"] == "gravity_ispindelconfiguration"
        })
    };
    let d = cal.map(|c| &c.data).unwrap_or(&sensor.data);
    let coeff = |k: &str| {
        d[k].as_f64()
            .or_else(|| d[k].as_str().and_then(|s| s.parse().ok()))
    };
    let calculated = coeff("constant_term")
        .map(|constant| {
            coeff("third_degree_coefficient").unwrap_or(0.0) * angle.powi(3)
                + coeff("second_degree_coefficient").unwrap_or(0.0) * angle.powi(2)
                + coeff("first_degree_coefficient").unwrap_or(0.0) * angle
                + constant
        })
        .filter(|g| g.is_finite() && (0.5..=2.0).contains(g));
    let reported = packet["gravity"].as_f64().filter(|n| n.is_finite());
    let reported_unit = sensor.data["reported_gravity_unit"]
        .as_str()
        .unwrap_or("unknown");
    let reported_sg = match (reported, reported_unit) {
        (Some(g), "SG") if (0.5..=2.0).contains(&g) => Some(g),
        (Some(g), "Plato") => plato_to_sg(g).ok(),
        _ => None,
    };
    let source = sensor.data["gravity_source"].as_str().unwrap_or("server");
    anyhow::ensure!(
        ["server", "device"].contains(&source),
        "Unknown gravity source"
    );
    let g = if source == "device" {
        reported_sg
    } else {
        calculated
    };
    // A fitted gravity formula must not discard the original temperature offset.
    let numeric = |v: &Value| {
        v.as_f64()
            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
    };
    let temperature_correction = coeff("temperature_correction")
        .or_else(|| {
            calibrations
                .iter()
                .find(|c| {
                    c.data["sensor"] == sensor.id
                        && c.data["legacy_table"] == "gravity_ispindelconfiguration"
                })
                .and_then(|c| numeric(&c.data["temperature_correction"]))
        })
        .or_else(|| numeric(&sensor.data["temperature_correction"]))
        .unwrap_or(0.0);
    let temp = convert(temperature, from, unit)? + temperature_correction;
    anyhow::ensure!(temp.is_finite(), "Invalid temperature");
    Ok(
        json!({"gravity":g.map(|g|(g*10000.0).round()/10000.0),"gravity_temp":temp,"temp_format":unit,"angle":angle,"battery":packet["battery"],"rssi":packet.get("RSSI").or(packet.get("rssi")),"reading_source":"ispindel","gravity_source":source,"server_gravity":calculated,"ispindel_gravity":reported,"ispindel_gravity_unit":reported_unit,"ispindel_gravity_sg":reported_sg,"calibration_id":sensor.data["active_ispindel_calibration"],"gravity_status":if g.is_some(){"ok"}else if source=="device"{"reported_unit_or_value_missing"}else{"calibration_missing_or_invalid"}}),
    )
}
fn store(c: &mut rusqlite::Connection, e: Entity, values: Value) -> Result<()> {
    let tx = c.transaction()?;
    store_values(&tx, e, values)?;
    tx.commit()?;
    Ok(())
}
pub(crate) fn store_values(tx: &rusqlite::Connection, mut e: Entity, values: Value) -> Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    e.data["last_seen"] = json!(now);
    e.data["last_values"] = values.clone();
    if matches!(
        values["reading_source"].as_str(),
        Some("ispindel" | "tilt" | "tiltbridge")
    ) {
        e.data["last_automatic"] = json!({"time":now,"values":values});
    }
    db::put(tx, &e)?;
    db::point(
        tx,
        &Point {
            source: e.id.clone(),
            time: now,
            sequence: next_sequence(tx, &e.id, now)?,
            values: values.clone(),
        },
    )?;
    for log in db::list(tx, "gravity_logs")? {
        if log.data["device"] == e.id && log.data["status"] == "active" {
            db::point(
                tx,
                &Point {
                    source: log.id.clone(),
                    time: now,
                    sequence: next_sequence(tx, &log.id, now)?,
                    values: values.clone(),
                },
            )?;
        }
    }
    for batch in db::list(tx, "batches")? {
        if batch.data["sensor"] == e.id && batch.data["status"] == "active" {
            db::append_point(tx, &batch.id, now, &values)?;
        }
    }
    Ok(())
}
fn next_sequence(c: &rusqlite::Connection, source: &str, time: i64) -> Result<i64> {
    Ok(c.query_row(
        "SELECT COALESCE(MAX(sequence),-1)+1 FROM points WHERE source=? AND time=?",
        rusqlite::params![source, time],
        |r| r.get(0),
    )?)
}
pub async fn ispindel(State(a): State<App>, Json(v): Json<Value>) -> Result<Json<Value>, ApiError> {
    if !a.collection {
        return Err(ApiError::bad("Collection is disabled"));
    }
    let token = v["token"]
        .as_str()
        .ok_or_else(|| ApiError::bad("Missing token"))?;
    let hash = auth::digest(token);
    a.db.run(move |c| {
        let sensors = db::list(c, "sensors")?;
        let sensor = sensors
            .into_iter()
            .find(|e| {
                e.data["ingest_hash"] == hash
                    && e.data["collection_enabled"] == true
                    && e.data["sensor_type"] == "ispindel"
            })
            .context("Unknown or disabled sensor token")?;
        let vals = ispindel_values(&v, &sensor, &db::list(c, "calibrations")?)?;
        store(c, sensor, vals)
    })
    .await?;
    Ok(Json(json!({"status":"ok"})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManualReading {
    pub gravity: f64,
    pub gravity_temp: Option<f64>,
    pub temp_format: Option<String>,
    pub note: Option<String>,
    pub angle: Option<f64>,
    pub angle_received_at: Option<i64>,
    #[serde(default)]
    pub calibration_reference: bool,
    #[serde(default)]
    pub temp_is_estimate: bool,
}
fn manual_values(v: ManualReading, e: &Entity, cal: &[Entity]) -> Result<Value> {
    anyhow::ensure!(e.kind == "sensors", "Select a gravity sensor");
    anyhow::ensure!(
        v.gravity.is_finite() && (0.5..=2.0).contains(&v.gravity),
        "Gravity must be SG between 0.5 and 2.0"
    );
    let unit = e.data["unit"]
        .as_str()
        .or(e.data["temp_format"].as_str())
        .unwrap_or("C");
    let temp = if let Some(n) = v.gravity_temp {
        anyhow::ensure!(n.is_finite(), "Invalid temperature");
        let converted = convert(n, v.temp_format.as_deref().unwrap_or(unit), unit)?;
        anyhow::ensure!(converted.is_finite(), "Invalid temperature");
        Some(converted)
    } else {
        None
    };
    let note = v.note.unwrap_or_default();
    anyhow::ensure!(note.len() <= 2000, "The note is too long");
    if let Some(angle) = v.angle {
        anyhow::ensure!(
            angle.is_finite() && (0.0..=180.0).contains(&angle),
            "Angle must be between 0 and 180 degrees"
        );
    }
    if v.calibration_reference {
        anyhow::ensure!(
            e.data["sensor_type"] == "ispindel" && v.angle.is_some(),
            "An iSpindel reference requires both angle and measured SG"
        );
    }
    let automatic = &e.data["last_automatic"];
    if let Some(time) = v.angle_received_at {
        let now = chrono::Utc::now().timestamp_millis();
        anyhow::ensure!(
            automatic["time"].as_i64() == Some(time)
                && (0..=300000).contains(&(now - time))
                && v.angle
                    .zip(automatic["values"]["angle"].as_f64())
                    .is_some_and(|(a, b)| (a - b).abs() < 1e-8),
            "The angle is stale or has changed. Load a recent packet or enter the angle manually."
        );
    }
    let mut gravity = v.gravity;
    if e.data["sensor_type"] == "manual" {
        for entry in cal.iter().filter(|x| {
            x.data["sensor"] == e.id && x.data["enabled"] == true && x.data["kind"] == "gravity"
        }) {
            gravity = entry.data["slope"].as_f64().unwrap_or(1.0) * v.gravity
                + entry.data["offset"].as_f64().unwrap_or(0.0);
        }
    }
    anyhow::ensure!(
        gravity.is_finite() && (0.5..=2.0).contains(&gravity),
        "Corrected gravity is outside the allowed range"
    );
    Ok(
        json!({"gravity":gravity,"raw_gravity":v.gravity,"reference_gravity":if v.calibration_reference{Some(v.gravity)}else{None},"gravity_temp":temp,"temp_format":unit,"reading_source":"manual","calibration_reference":v.calibration_reference,"angle":v.angle,"angle_received_at":v.angle_received_at,"note":note,"temp_is_estimate":v.temp_is_estimate,"ispindel_gravity":if v.angle_received_at.is_some(){automatic["values"]["ispindel_gravity"].clone()}else{Value::Null},"ispindel_gravity_unit":automatic["values"]["ispindel_gravity_unit"]}),
    )
}
pub async fn manual(
    State(a): State<App>,
    Path(id): Path<String>,
    Json(v): Json<ManualReading>,
) -> Result<Json<Value>, ApiError> {
    a.db.run(move |c| {
        let e = db::get(c, &id)?;
        let values = manual_values(v, &e, &db::list(c, "calibrations")?)?;
        store(c, e, values)
    })
    .await?;
    Ok(Json(json!({"saved":true})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceChoice {
    pub gravity_source: String,
    pub reported_gravity_unit: String,
}
pub async fn source(
    State(a): State<App>,
    Path(id): Path<String>,
    Json(v): Json<SourceChoice>,
) -> Result<Json<Value>, ApiError> {
    a.db.run(move|c|{let tx=c.transaction()?;let mut e=db::get(&tx,&id)?;anyhow::ensure!(e.kind=="sensors"&&e.data["sensor_type"]=="ispindel","Select an iSpindel");
        let before=json!({"source":e.data["gravity_source"],"unit":e.data["reported_gravity_unit"]});e.data["gravity_source"]=json!(v.gravity_source);e.data["reported_gravity_unit"]=json!(v.reported_gravity_unit);db::put(&tx,&e)?;
        tx.execute("INSERT INTO audit VALUES(?,?,?)",rusqlite::params![chrono::Utc::now().timestamp(),"density_source_change",json!({"sensor":id,"before":before,"source":v.gravity_source,"unit":v.reported_gravity_unit}).to_string()])?;tx.commit()?;Ok(())
    }).await?;
    Ok(Json(json!({"saved":true,"future_readings_only":true})))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn units_and_ispindel_calibration() {
        assert_eq!(convert(32.0, "F", "C").unwrap(), 0.0);
        let e = Entity {
            id: "s".into(),
            kind: "sensors".into(),
            name: "Test".into(),
            data: json!({"unit":"C","constant_term":1.0,"first_degree_coefficient":0.001}),
        };
        let v = ispindel_values(
            &json!({"angle":50,"temperature":68,"temp_units":"F"}),
            &e,
            &[],
        )
        .unwrap();
        assert_eq!(v["gravity"], 1.05);
        assert_eq!(v["gravity_temp"], 20.0);
        assert!(ispindel_values(&json!({"angle":200,"temperature":20}), &e, &[]).is_err());
    }
}

#[cfg(test)]
mod density_tests {
    use super::*;
    fn sensor() -> Entity {
        Entity {
            id: "s".into(),
            kind: "sensors".into(),
            name: "Test".into(),
            data: json!({"sensor_type":"ispindel","unit":"C","constant_term":1.0,"first_degree_coefficient":0.001}),
        }
    }
    fn manual(v: Value, e: &Entity) -> Result<Value> {
        manual_values(serde_json::from_value(v)?, e, &[])
    }
    #[test]
    fn source_choice_keeps_raw_values_and_requires_explicit_units() {
        let mut e = sensor();
        let packet = json!({"angle":50,"temperature":20,"gravity":12.});
        let v = ispindel_values(&packet, &e, &[]).unwrap();
        assert_eq!(v["gravity"], 1.05);
        assert_eq!(v["ispindel_gravity"], 12.);
        assert!(v["ispindel_gravity_sg"].is_null());
        e.data["gravity_source"] = json!("device");
        assert!(db::validate(&e).is_err());
        e.data["reported_gravity_unit"] = json!("Plato");
        assert!(db::validate(&e).is_ok());
        let v = ispindel_values(&packet, &e, &[]).unwrap();
        assert!((v["gravity"].as_f64().unwrap() - 1.0484).abs() < 0.0001);
        assert_eq!(v["server_gravity"], 1.05);
        e.data["reported_gravity_unit"] = json!("SG");
        let v = ispindel_values(&packet, &e, &[]).unwrap();
        assert!(v["gravity"].is_null());
        let missing = Entity {
            data: json!({"sensor_type":"ispindel"}),
            ..sensor()
        };
        let v = ispindel_values(&packet, &missing, &[]).unwrap();
        assert!(v["gravity"].is_null());
        assert_eq!(v["angle"], 50.);
    }
    #[test]
    fn manual_ispindel_reference_is_not_recalibrated_and_pairing_is_checked() {
        let mut e = sensor();
        let now = chrono::Utc::now().timestamp_millis();
        e.data["last_automatic"] = json!({"time":now,"values":{"angle":45.,"ispindel_gravity":1.04,"ispindel_gravity_unit":"SG"}});
        let input = json!({"gravity":1.042,"angle":45.,"angle_received_at":now,"calibration_reference":true});
        let v = manual(input.clone(), &e).unwrap();
        assert_eq!(v["gravity"], 1.042);
        assert_eq!(v["ispindel_gravity"], 1.04);
        assert!(v["gravity_temp"].is_null());
        let mut bad = input.clone();
        bad["angle"] = json!(44.);
        assert!(manual(bad, &e).is_err());
        e.data["last_automatic"]["time"] = json!(now - 400000);
        assert!(manual(input, &e).is_err());
        assert!(manual(json!({"gravity":1.04,"calibration_reference":true}), &e).is_err());
        assert!(
            manual(
                json!({"gravity":1.04,"angle":40.,"calibration_reference":true}),
                &e
            )
            .is_ok()
        );
        assert!(manual(json!({"gravity":1.04}), &e).is_ok());
    }
    #[test]
    fn linked_batch_keeps_both_streams_and_completion_stops_gravity_log() {
        let dir = tempfile::tempdir().unwrap();
        let db = db::Db::init(dir.path().join("batch.sqlite")).unwrap();
        let mut c = db.open().unwrap();
        let sensor = sensor();
        db::put(&c, &sensor).unwrap();
        let mut batch = Entity {
            id: "batch".into(),
            kind: "batches".into(),
            name: "Batch".into(),
            data: json!({"sensor":"s","status":"active"}),
        };
        db::put(&c, &batch).unwrap();
        let v = manual(json!({"gravity":1.042}), &sensor).unwrap();
        store(&mut c, sensor.clone(), v.clone()).unwrap();
        let points = db::points(&c, "batch", 10).unwrap();
        assert_eq!(points.len(), 1);
        db::append_point(&c, "batch", points[0].time, &json!({"beer_temp":18.5})).unwrap();
        assert_eq!(db::points(&c, "batch", 10).unwrap().len(), 2);
        batch.data["status"] = json!("completed");
        db::put(&c, &batch).unwrap();
        store(&mut c, sensor, v).unwrap();
        assert_eq!(db::points(&c, "s", 10).unwrap().len(), 2);
        assert_eq!(db::points(&c, "batch", 10).unwrap().len(), 2);
    }
    #[test]
    fn manual_and_automatic_points_fan_out_without_overwriting_same_millisecond() {
        let dir = tempfile::tempdir().unwrap();
        let db = db::Db::init(dir.path().join("points.sqlite")).unwrap();
        let mut conn = db.open().unwrap();
        let e = sensor();
        db::put(&conn, &e).unwrap();
        db::put(
            &conn,
            &Entity {
                id: "log".into(),
                kind: "gravity_logs".into(),
                name: "Test log".into(),
                data: json!({"device":"s","status":"active"}),
            },
        )
        .unwrap();
        store(
            &mut conn,
            e,
            json!({"reading_source":"ispindel","gravity":1.05,"angle":45}),
        )
        .unwrap();
        let e = db::get(&conn, "s").unwrap();
        let automatic = e.data["last_automatic"].clone();
        let v = manual(json!({"gravity":1.042}), &e).unwrap();
        store(&mut conn, e, v).unwrap();
        assert_eq!(
            db::get(&conn, "s").unwrap().data["last_automatic"],
            automatic
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM points", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            4
        );
        assert!(next_sequence(&conn, "s", automatic["time"].as_i64().unwrap()).unwrap() >= 1);
    }
}

#[cfg(test)]
mod temperature_regression {
    use super::*;
    #[test]
    fn gravity_fit_preserves_imported_temperature_correction() {
        let sensor = Entity {
            id: "s".into(),
            kind: "sensors".into(),
            name: "Test".into(),
            data: json!({"sensor_type":"ispindel","unit":"C","active_ispindel_calibration":"fit"}),
        };
        let imported = Entity {
            id: "old".into(),
            kind: "calibrations".into(),
            name: "Original".into(),
            data: json!({"sensor":"s","legacy_table":"gravity_ispindelconfiguration","constant_term":1.0,"temperature_correction":"2.5"}),
        };
        let fitted = Entity {
            id: "fit".into(),
            kind: "calibrations".into(),
            name: "Fit".into(),
            data: json!({"sensor":"s","enabled":true,"constant_term":1.02}),
        };
        let values = ispindel_values(
            &json!({"angle":45,"temperature":68,"temp_units":"F"}),
            &sensor,
            &[imported, fitted],
        )
        .unwrap();
        assert_eq!(values["gravity"], 1.02);
        assert_eq!(values["gravity_temp"], 22.5);
    }
}

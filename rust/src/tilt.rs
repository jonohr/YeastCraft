// SPDX-License-Identifier: GPL-3.0-only
//! Experimental HTTP receivers. See docs/TILT.md for pinned protocol references.
use crate::{ApiError, App, auth, db, sensors};
use anyhow::{Context, Result, ensure};
use axum::{
    Form, Json,
    extract::{Path, State},
};
use serde::Deserialize;
use serde_json::{Value, json};

const COLORS: [&str; 8] = [
    "RED", "GREEN", "BLACK", "PURPLE", "ORANGE", "BLUE", "YELLOW", "PINK",
];
fn identity(value: &str) -> Result<(String, Option<String>)> {
    let (color, mac) = value
        .split_once(':')
        .map_or((value, None), |(a, b)| (a, Some(b)));
    let color = color.to_ascii_uppercase();
    ensure!(COLORS.contains(&color.as_str()), "Unknown Tilt color");
    if let Some(mac) = mac {
        ensure!(
            mac.len() == 17
                && mac.split(':').count() == 6
                && mac
                    .split(':')
                    .all(|s| s.len() == 2 && s.bytes().all(|b| b.is_ascii_hexdigit())),
            "Invalid Tilt MAC address"
        );
    }
    Ok((color, mac.map(str::to_ascii_lowercase)))
}
pub fn validate_config(data: &Value) -> Result<()> {
    let (color, mac) = identity(data["tilt_color"].as_str().context("Choose a Tilt color")?)?;
    ensure!(
        !color.is_empty() && mac.is_none(),
        "Use the separate MAC field"
    );
    let mac = data["tilt_mac"].as_str().unwrap_or("");
    if !mac.is_empty() {
        identity(&format!("RED:{mac}"))?;
    }
    ensure!(
        matches!(data["unit"].as_str(), Some("C" | "F")),
        "Choose C or F"
    );
    if data["sensor_type"] == "tilt" {
        ensure!(
            data["tilt_utc_offset_minutes"]
                .as_i64()
                .is_some_and(|n| (-720..=840).contains(&n)),
            "Set the sender UTC offset in minutes (-720 to 840)"
        );
    } else {
        ensure!(
            mac.is_empty(),
            "Legacy TiltBridge identifies sensors by color, not MAC"
        );
        ensure!(
            data["tilt_bridge_id"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 100),
            "Enter the TiltBridge mDNS ID"
        );
    }
    Ok(())
}
fn numeric(v: &Value) -> Result<f64> {
    let n = v
        .as_f64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .context("Missing numeric measurement")?;
    ensure!(n.is_finite(), "Non-finite measurement");
    Ok(n)
}
fn values(sg: f64, temp: f64, from: &str, sensor: &db::Entity, source: &str) -> Result<Value> {
    ensure!(
        sg.is_finite() && (0.5..=2.).contains(&sg),
        "Gravity must be SG between 0.5 and 2.0"
    );
    let celsius = sensors::convert(temp, from, "C")?;
    ensure!(
        celsius.is_finite() && (-40.0..=100.0).contains(&celsius),
        "Temperature is outside the supported range"
    );
    let unit = sensor.data["unit"]
        .as_str()
        .context("Missing temperature unit")?;
    Ok(
        json!({"gravity":sg,"gravity_temp":sensors::convert(temp, from, unit)?,"temp_format":unit,
        "reading_source":source,"gravity_source":"device","gravity_status":"ok","experimental":true}),
    )
}
#[derive(Deserialize)]
pub struct CloudPacket {
    #[serde(rename = "Timepoint")]
    timepoint: String,
    #[serde(rename = "Temp")]
    temp: String,
    #[serde(rename = "SG")]
    sg: String,
    #[serde(rename = "Color")]
    color: String,
}
fn cloud_values(packet: &CloudPacket, sensor: &db::Entity, now: i64) -> Result<(Value, i64)> {
    let (color, mac) = identity(&packet.color)?;
    ensure!(
        color.eq_ignore_ascii_case(sensor.data["tilt_color"].as_str().unwrap_or("")),
        "Tilt color does not match this receiver"
    );
    let wanted = sensor.data["tilt_mac"].as_str().unwrap_or("");
    ensure!(
        wanted.is_empty()
            || mac
                .as_deref()
                .is_some_and(|m| m.eq_ignore_ascii_case(wanted)),
        "Tilt MAC does not match this receiver"
    );
    let stamp = numeric(&json!(packet.timepoint))?;
    let offset = sensor.data["tilt_utc_offset_minutes"]
        .as_i64()
        .context("Missing sender UTC offset")?;
    let unix_ms = (stamp - 25569.) * 86400000. - offset as f64 * 60000.;
    ensure!(
        unix_ms.is_finite()
            && unix_ms >= (now - 7200000) as f64
            && unix_ms <= (now + 300000) as f64,
        "Stale or future Tilt timestamp; check sender clock and UTC offset"
    );
    let mut v = values(
        numeric(&json!(packet.sg))?,
        numeric(&json!(packet.temp))?,
        "F",
        sensor,
        "tilt",
    )?;
    v["source_timepoint"] = json!(stamp);
    v["source_time"] = json!(unix_ms.round() as i64);
    v["tilt_color"] = json!(color);
    v["tilt_mac"] = json!(mac);
    Ok((v, unix_ms.round() as i64))
}
fn bridge_values(packet: &Value, sensor: &db::Entity) -> Result<Value> {
    ensure!(
        packet["mdns_id"] == sensor.data["tilt_bridge_id"],
        "TiltBridge ID does not match this receiver"
    );
    let tilts = packet["tilts"]
        .as_object()
        .context("Expected a TiltBridge color map")?;
    ensure!(tilts.len() <= 8, "Too many Tilt colors");
    let wanted = sensor.data["tilt_color"]
        .as_str()
        .context("Missing Tilt color")?;
    let matching: Vec<_> = tilts
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case(wanted))
        .collect();
    ensure!(
        matching.len() == 1,
        "Selected Tilt color is missing or ambiguous"
    );
    let (_, p) = matching[0];
    ensure!(
        p["color"]
            .as_str()
            .is_some_and(|c| c.eq_ignore_ascii_case(wanted)),
        "Inconsistent TiltBridge color"
    );
    let mut v = values(
        numeric(&p["gravity"])?,
        numeric(&p["temp"])?,
        p["tempUnit"].as_str().context("Missing temperature unit")?,
        sensor,
        "tiltbridge",
    )?;
    v["tilt_color"] = json!(wanted.to_ascii_uppercase());
    // Battery weeks are not battery voltage. Do not map them to the iSpindel field.
    if p["sends_battery"] == true
        && let Some(n) = p["weeks_on_battery"].as_u64().filter(|n| *n <= 255)
    {
        v["weeks_on_battery"] = json!(n);
    }
    v["high_resolution"] = json!(p["high_resolution"] == true);
    if let Some(n) = p["rssi"].as_i64().filter(|n| (-127..=0).contains(n)) {
        v["rssi"] = json!(n);
    }
    Ok(v)
}
fn find_sensor(c: &rusqlite::Connection, hash: &str, kind: &str) -> Result<db::Entity> {
    db::list(c, "sensors")?
        .into_iter()
        .find(|e| {
            e.data["ingest_hash"] == hash
                && e.data["sensor_type"] == kind
                && e.data["collection_enabled"] == true
        })
        .context("Unknown or disabled receiving token")
}
pub async fn cloud(
    State(a): State<App>,
    Path(token): Path<String>,
    Form(packet): Form<CloudPacket>,
) -> Result<Json<Value>, ApiError> {
    ensure_collection(&a)?;
    let hash = auth::digest(&token);
    a.db.run(move |c| {
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut sensor = find_sensor(&tx, &hash, "tilt")?;
        validate_config(&sensor.data)?;
        let (v, stamp) = cloud_values(&packet, &sensor, chrono::Utc::now().timestamp_millis())?;
        // Persisted watermark prevents retries/out-of-order packets becoming new observations.
        if sensor.data["tilt_last_source_time"]
            .as_i64()
            .is_some_and(|last| stamp <= last)
        {
            return Ok(());
        }
        sensor.data["tilt_last_source_time"] = json!(stamp);
        sensors::store_values(&tx, sensor, v)?;
        tx.commit()?;
        Ok(())
    })
    .await?;
    Ok(Json(json!({"result":"success"})))
}
pub async fn bridge(
    State(a): State<App>,
    Path(token): Path<String>,
    Json(packet): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    ensure_collection(&a)?;
    let hash = auth::digest(&token);
    a.db.run(move |c| {
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut sensor = find_sensor(&tx, &hash, "tiltbridge")?;
        validate_config(&sensor.data)?;
        let v = bridge_values(&packet, &sensor)?;
        let now = chrono::Utc::now().timestamp_millis();
        // Legacy bridge has no sample timestamp/ID. Only suppress immediate identical retries.
        let fingerprint = auth::digest(&v.to_string());
        if sensor.data["tilt_last_packet"] == fingerprint
            && sensor.data["last_automatic"]["time"]
                .as_i64()
                .is_some_and(|last| now - last < 10000)
        {
            return Ok(());
        }
        sensor.data["tilt_last_packet"] = json!(fingerprint);
        sensors::store_values(&tx, sensor, v)?;
        tx.commit()?;
        Ok(())
    })
    .await?;
    Ok(Json(json!({"result":"success"})))
}
fn ensure_collection(a: &App) -> Result<(), ApiError> {
    if !a.collection {
        return Err(ApiError::bad("Collection is disabled"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sensor(kind: &str) -> db::Entity {
        db::Entity {
            id: "test".into(),
            kind: "sensors".into(),
            name: "Test".into(),
            data: json!({"sensor_type":kind,"tilt_color":"PINK","tilt_utc_offset_minutes":0,"unit":"C","tilt_bridge_id":"test-bridge"}),
        }
    }
    fn packet() -> CloudPacket {
        // Literal measurement and timestamp from manufacturer's example, not our emulator.
        CloudPacket {
            timepoint: "43331.79300001158".into(),
            temp: "65.0".into(),
            sg: "1.01".into(),
            color: "PINK".into(),
        }
    }
    fn now() -> i64 {
        ((43331.79300001158 - 25569.) * 86400000_f64).round() as i64
    }
    #[test]
    fn official_cloud_example_units_identity_and_clock() {
        let mut e = sensor("tilt");
        let (v, _) = cloud_values(&packet(), &e, now()).unwrap();
        assert!((v["gravity_temp"].as_f64().unwrap() - 18.3333333).abs() < 0.00001);
        assert_eq!(v["gravity"], 1.01);
        assert!(cloud_values(&packet(), &e, now() + 7200001).is_err());
        assert!(cloud_values(&packet(), &e, now() - 300001).is_err());
        e.data["tilt_utc_offset_minutes"] = json!(60);
        assert!(cloud_values(&packet(), &e, now() - 3600000).is_ok());
        e.data["tilt_color"] = json!("RED");
        assert!(cloud_values(&packet(), &e, now()).is_err());
    }
    #[test]
    fn cloud_mac_and_invalid_values_are_not_silently_accepted() {
        let mut p = packet();
        let mut e = sensor("tilt");
        e.data["tilt_mac"] = json!("aa:bb:cc:dd:ee:ff");
        assert!(cloud_values(&p, &e, now()).is_err());
        p.color = "pink:AA:BB:CC:DD:EE:FF".into();
        assert!(cloud_values(&p, &e, now()).is_ok());
        for sg in ["NaN", "inf", "1050", "0", "oops"] {
            p.sg = sg.into();
            assert!(cloud_values(&p, &e, now()).is_err());
        }
        p.sg = "1.0123".into();
        p.temp = "NaN".into();
        assert!(cloud_values(&p, &e, now()).is_err());
    }
    #[test]
    fn bridge_reference_shape_keeps_pro_precision_and_battery_semantics() {
        let p: Value = serde_json::from_str(include_str!("testdata/tiltbridge.json")).unwrap();
        let mut e = sensor("tiltbridge");
        let v = bridge_values(&p, &e).unwrap();
        assert_eq!(v["gravity"], 1.0123);
        assert_eq!(v["gravity_temp"], 20.0);
        assert_eq!(v["weeks_on_battery"], 3);
        assert!(v.get("battery").is_none());
        e.data["tilt_color"] = json!("RED");
        let v = bridge_values(&p, &e).unwrap();
        assert_eq!(v["gravity_temp"], 20.0);
        assert!(v.get("weeks_on_battery").is_none());
    }
    #[test]
    fn bridge_rejects_wrong_origin_color_units_and_ambiguous_map() {
        let p: Value = serde_json::from_str(include_str!("testdata/tiltbridge.json")).unwrap();
        let e = sensor("tiltbridge");
        for (field, value) in [
            ("tempUnit", json!("K")),
            ("color", json!("RED")),
            ("gravity", json!("NaN")),
        ] {
            let mut bad = p.clone();
            bad["tilts"]["Pink"][field] = value;
            assert!(bridge_values(&bad, &e).is_err());
        }
        let mut bad = p.clone();
        bad["mdns_id"] = json!("other");
        assert!(bridge_values(&bad, &e).is_err());
        let mut bad = p.clone();
        bad["tilts"]["PINK"] = p["tilts"]["Pink"].clone();
        assert!(bridge_values(&bad, &e).is_err());
        let mut bad = p;
        bad["tilts"].as_object_mut().unwrap().remove("Pink");
        assert!(bridge_values(&bad, &e).is_err());
    }
    #[test]
    fn disabled_legacy_records_can_be_saved_but_not_enabled_without_setup() {
        let mut e = sensor("tilt");
        e.data = json!({"sensor_type":"tilt","collection_enabled":false,"legacy_table":"gravity_gravitysensor"});
        assert!(db::validate(&e).is_ok());
        e.data["collection_enabled"] = json!(true);
        assert!(db::validate(&e).is_err());
    }
    #[test]
    fn configuration_rejects_unknown_colors_and_invalid_offsets() {
        let mut e = sensor("tilt");
        assert!(validate_config(&e.data).is_ok());
        e.data["tilt_color"] = json!("BROWN");
        assert!(validate_config(&e.data).is_err());
        e.data["tilt_color"] = json!("RED");
        e.data["tilt_utc_offset_minutes"] = json!(0.5);
        assert!(validate_config(&e.data).is_err());
        let mut e = sensor("tiltbridge");
        e.data["tilt_mac"] = json!("aa:bb:cc:dd:ee:ff");
        assert!(validate_config(&e.data).is_err());
    }
}

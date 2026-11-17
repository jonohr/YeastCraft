// SPDX-License-Identifier: GPL-3.0-only
use crate::{ApiError, App, db};
use anyhow::{Result, bail};
use axum::{
    Json,
    extract::{Path, State},
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::TcpStream,
    time::{Duration, timeout},
};
pub mod log;
pub mod pins;
type OperationLocks =
    std::sync::Mutex<std::collections::HashMap<String, std::sync::Weak<tokio::sync::Mutex<()>>>>;
static OPERATIONS: std::sync::OnceLock<OperationLocks> = std::sync::OnceLock::new();
pub(crate) fn operation(id: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    let mut locks = OPERATIONS.get_or_init(Default::default).lock().unwrap();
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(id).and_then(std::sync::Weak::upgrade) {
        return lock;
    }
    let lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(id.to_string(), std::sync::Arc::downgrade(&lock));
    lock
}
pub fn parse_temperature(line: &str) -> Result<Value> {
    let v: Value = serde_json::from_str(
        line.trim()
            .strip_prefix("T:")
            .ok_or_else(|| anyhow::anyhow!("Not a temperature frame"))?,
    )?;
    let mut out = serde_json::Map::new();
    for (from, to) in [
        ("bt", "beer_temp"),
        ("bs", "beer_set"),
        ("ft", "fridge_temp"),
        ("fs", "fridge_set"),
        ("rt", "room_temp"),
        ("s", "state"),
        ("BeerTemp", "beer_temp"),
        ("BeerSet", "beer_set"),
        ("FridgeTemp", "fridge_temp"),
        ("FridgeSet", "fridge_set"),
        ("RoomTemp", "room_temp"),
        ("Log1Temp", "room_temp"),
        ("State", "state"),
    ] {
        if let Some(n) = v.get(from) {
            anyhow::ensure!(
                n.is_null() || n.as_f64().is_some(),
                "Invalid numeric field {from}"
            );
            out.insert(to.into(), n.clone());
        }
    }
    Ok(Value::Object(out))
}
trait ControllerIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> ControllerIo for T {}
#[cfg(test)]
async fn exchange(host: &str, port: u16, cmd: &str, prefix: &str) -> Result<String> {
    let d = db::Entity {
        id: String::new(),
        kind: "devices".into(),
        name: String::new(),
        data: json!({"host":host,"port":port}),
    };
    exchange_device(&d, cmd, prefix).await
}
struct Transport {
    signature: String,
    reader: Option<BufReader<Box<dyn ControllerIo>>>,
}
type TransportPool = std::sync::Arc<
    tokio::sync::Mutex<
        std::collections::HashMap<String, std::sync::Arc<tokio::sync::Mutex<Transport>>>,
    >,
>;
static TRANSPORTS: std::sync::OnceLock<TransportPool> = std::sync::OnceLock::new();
pub async fn release(id: &str) {
    if let Some(pool) = TRANSPORTS.get() {
        pool.lock().await.remove(id);
    }
}
async fn exchange_device(d: &db::Entity, cmd: &str, prefix: &str) -> Result<String> {
    exchange_device_confirmed(d, cmd, prefix, None).await
}
fn settings_match(actual: &Value, wanted: &Value) -> bool {
    actual["mode"] == wanted["mode"]
        && ["beerSet", "fridgeSet"].iter().all(|&key| {
            wanted[key].as_f64().is_none_or(|n| {
                actual[key]
                    .as_f64()
                    .is_some_and(|value| (value - n).abs() <= 0.02)
            })
        })
}
fn settings_command(wanted: &Value) -> String {
    // Legacy firmware applies JSON properties in wire order. Setting mode can
    // clear beerSet, so serialize mode first rather than map/alphabetical order.
    let mut fields = vec![format!("\"mode\":{}", wanted["mode"])];
    for key in ["beerSet", "fridgeSet"] {
        if let Some(value) = wanted.get(key) {
            fields.push(format!("\"{key}\":{value}"));
        }
    }
    format!("j{{{}}}\ns\n", fields.join(","))
}
async fn exchange_device_confirmed(
    d: &db::Entity,
    cmd: &str,
    prefix: &str,
    wanted: Option<&Value>,
) -> Result<String> {
    let signature = format!(
        "{}:{}:{}:{}",
        d.data["connection_type"], d.data["serial_port"], d.data["host"], d.data["port"]
    );
    let key = if d.id.is_empty() {
        signature.clone()
    } else {
        d.id.clone()
    };
    let pool = TRANSPORTS.get_or_init(Default::default);
    let transport = {
        let mut map = pool.lock().await;
        map.entry(key)
            .or_insert_with(|| {
                std::sync::Arc::new(tokio::sync::Mutex::new(Transport {
                    signature: signature.clone(),
                    reader: None,
                }))
            })
            .clone()
    };
    let mut transport = transport.lock().await;
    if transport.signature != signature {
        transport.reader = None;
        transport.signature = signature;
    }
    let result = timeout(Duration::from_secs(22), async {
        use tokio_serial::SerialPortBuilderExt;
        if transport.reader.is_none() {
            let stream: Box<dyn ControllerIo> = if d.data["connection_type"] == "serial" {
                let path = d.data["serial_port"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing serial path"))?;
                anyhow::ensure!(path.starts_with("/dev/"), "Serial path must be a device");
                let mut serial =
                    tokio_serial::new(path, d.data["baud"].as_u64().unwrap_or(57600) as u32)
                        .open_native_async()?;
                serial.set_exclusive(true)?;
                if d.data["board_type"] == "uno" {
                    tokio::time::sleep(Duration::from_secs(10)).await;
                }
                Box::new(serial)
            } else {
                let host = d.data["host"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing hostname"))?;
                let port = d.data["port"].as_u64().unwrap_or(23);
                anyhow::ensure!(port > 0 && port <= 65535, "Invalid port");
                Box::new(TcpStream::connect((host, port as u16)).await?)
            };
            transport.reader = Some(BufReader::new(stream));
        }
        let reader = transport.reader.as_mut().unwrap();
        reader.get_mut().write_all(cmd.as_bytes()).await?;
        for line in cmd.lines() {
            log::record(&d.id, "TX", line);
        }
        for _ in 0..32 {
            let mut bytes = Vec::new();
            let mut complete = false;
            for _ in 0..16384 {
                let byte = reader.read_u8().await?;
                if byte == b'\n' {
                    complete = true;
                    break;
                }
                bytes.push(byte);
            }
            anyhow::ensure!(complete, "Controller frame exceeds 16 KiB");
            let line = String::from_utf8(bytes)?;
            log::record(&d.id, "RX", &line);
            if let Some(body) = line.strip_prefix(prefix) {
                // Firmware sends unsolicited settings/constants after writes.
                // A queued S frame can describe an earlier command; it must not
                // confirm or reject the new one. Keep reading, without resending
                // a write, until its requested settings arrive within the bounds.
                if let Some(wanted) = wanted {
                    let actual: Value = serde_json::from_str(body.trim())?;
                    if !settings_match(&actual, wanted) {
                        continue;
                    }
                }
                return Ok(line.trim().to_string());
            }
        }
        bail!("Expected controller frame was not received")
    })
    .await;
    match result {
        Ok(Ok(line)) => Ok(line),
        Ok(Err(e)) => {
            log::record(&d.id, "ERROR", &e.to_string());
            transport.reader = None;
            Err(e)
        }
        Err(e) => {
            log::record(&d.id, "ERROR", &e.to_string());
            transport.reader = None;
            Err(e.into())
        }
    }
}
async fn ensure_units(d: &db::Entity) -> Result<()> {
    let response = exchange_device(d, "c\n", "C:").await?;
    let constants: Value = serde_json::from_str(response.trim_start_matches("C:"))?;
    anyhow::ensure!(
        constants["tempFormat"].as_str() == Some(d.data["unit"].as_str().unwrap_or("C")),
        "Controller temperature units differ from configured units; refusing commands and mislabeled readings"
    );
    Ok(())
}
pub async fn collect(a: App) {
    loop {
        let devices =
            a.db.run(|c| db::list(c, "devices"))
                .await
                .unwrap_or_default();
        if let Some(pool) = TRANSPORTS.get() {
            let active = devices
                .iter()
                .filter(|d| d.data["collection_enabled"] == true)
                .map(|d| d.id.as_str())
                .collect::<std::collections::HashSet<_>>();
            pool.lock()
                .await
                .retain(|key, _| active.contains(key.as_str()));
        }
        for d in devices {
            if d.data["collection_enabled"] != true {
                continue;
            }
            if let Err(error) = ensure_units(&d).await {
                let id = d.id.clone();
                let msg = error.to_string();
                let _ =
                    a.db.run(move |c| {
                        let mut current = db::get(c, &id)?;
                        current.data["last_error"] = json!(msg);
                        db::put(c, &current)
                    })
                    .await;
                continue;
            }
            if a.control
                && d.data["control_claimed"] == true
                && d.data["profile"].is_string()
                && let Err(error) = profile_tick(&a, &d).await
            {
                let id = d.id.clone();
                let msg = error.to_string();
                let _ =
                    a.db.run(move |c| {
                        let mut current = db::get(c, &id)?;
                        current.data["profile_error"] = json!(msg);
                        db::put(c, &current)
                    })
                    .await;
            }
            let result = exchange_device(&d, "t\n", "T:")
                .await
                .and_then(|l| parse_temperature(&l));
            let id = d.id.clone();
            match result {
                Ok(mut values) => {
                    values["temp_format"] = json!(d.data["unit"].as_str().unwrap_or("C"));
                    let now = chrono::Utc::now().timestamp_millis();
                    let _ =
                        a.db.run(move |c| {
                            let mut current = db::get(c, &id)?;
                            current.data["last_seen"] = json!(now);
                            current.data["last_values"] = values.clone();
                            current.data["last_error"] = Value::Null;
                            db::put(c, &current)?;
                            db::point(
                                c,
                                &db::Point {
                                    source: id.clone(),
                                    time: now,
                                    sequence: 0,
                                    values: values.clone(),
                                },
                            )?;
                            for b in db::list(c, "batches")? {
                                if b.data["device"] == id && b.data["status"] == "active" {
                                    db::append_point(c, &b.id, now, &values)?;
                                }
                            }
                            Ok(())
                        })
                        .await;
                }
                Err(e) => {
                    let msg = e.to_string();
                    let _ =
                        a.db.run(move |c| {
                            let mut d = db::get(c, &id)?;
                            d.data["last_error"] = json!(msg);
                            db::put(c, &d)
                        })
                        .await;
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
}
#[derive(Deserialize)]
pub struct Command {
    mode: String,
    temperature: Option<f64>,
    #[serde(default)]
    confirm_ownership: bool,
}
pub async fn command(
    State(a): State<App>,
    Path(id): Path<String>,
    Json(v): Json<Command>,
) -> Result<Json<Value>, ApiError> {
    let operation = operation(&id);
    let _guard = operation.lock().await;
    if !a.control {
        return Err(ApiError::bad(
            "Temperature control is disabled on the server",
        ));
    }
    if !v.confirm_ownership {
        return Err(ApiError::bad(
            "Confirm the original Fermentrack does not control this device",
        ));
    }
    let id2 = id.clone();
    let d = a.db.run(move |c| db::get(c, &id2)).await?;
    if d.kind != "devices" || d.data["control_claimed"] != true {
        return Err(ApiError::bad("Controller ownership has not been confirmed"));
    }
    let mut payload = json!({"mode":v.mode});
    match v.mode.as_str() {
        "o" => {}
        "b" | "f" => {
            let n = v
                .temperature
                .ok_or_else(|| ApiError::bad("Temperature is required"))?;
            let (min, max) = if d.data["unit"] == "F" {
                (-4.0, 122.0)
            } else {
                (-20.0, 50.0)
            };
            if !n.is_finite() || !(min..=max).contains(&n) {
                return Err(ApiError::bad("Temperature is outside the allowed range"));
            }
            payload[if v.mode == "b" {
                "beerSet"
            } else {
                "fridgeSet"
            }] = json!(n);
        }
        _ => {
            return Err(ApiError::bad(
                "Only beer temperature, chamber temperature and off are supported",
            ));
        }
    };
    ensure_units(&d).await?;
    let line =
        exchange_device_confirmed(&d, &settings_command(&payload), "S:", Some(&payload)).await?;
    let actual: Value = serde_json::from_str(line.trim_start_matches("S:"))
        .map_err(|_| ApiError::bad("Invalid confirmation"))?;
    if actual["mode"] != payload["mode"] {
        return Err(ApiError::bad(
            "The controller did not confirm the requested mode",
        ));
    }
    for key in ["beerSet", "fridgeSet"] {
        if let Some(wanted) = payload[key].as_f64()
            && actual[key]
                .as_f64()
                .is_none_or(|n| (n - wanted).abs() > 0.02)
        {
            return Err(ApiError::bad(
                "The controller did not confirm the temperature",
            ));
        }
    }
    a.db.run(move |c| {
        let mut device = db::get(c, &id)?;
        device.data["profile"] = Value::Null;
        device.data["profile_started"] = Value::Null;
        device.data["profile_run"] = Value::Null;
        db::put(c, &device)?;
        c.execute(
            "INSERT INTO audit VALUES(?,?,?)",
            rusqlite::params![
                chrono::Utc::now().timestamp(),
                "controller_command",
                json!({"device":id,"requested":payload,"confirmed":actual}).to_string()
            ],
        )?;
        Ok(())
    })
    .await?;
    Ok(Json(json!({"confirmed":true})))
}
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncBufReadExt;
    #[test]
    fn frames() {
        let v = parse_temperature("T:{\"bt\":0,\"ft\":18.5,\"bs\":null,\"s\":4}\r\n").unwrap();
        assert_eq!(v["beer_temp"], 0);
        assert!(v["beer_set"].is_null());
        assert!(parse_temperature("T:{\"bt\":\"bad\"}").is_err());
        assert!(parse_temperature("D:debug").is_err());
    }
    #[test]
    fn mode_is_serialized_before_setpoints_for_legacy_firmware() {
        assert_eq!(
            settings_command(&json!({"beerSet":2.0,"mode":"b"})),
            "j{\"mode\":\"b\",\"beerSet\":2.0}\ns\n"
        );
        assert_eq!(
            settings_command(&json!({"fridgeSet":2.5,"mode":"f"})),
            "j{\"mode\":\"f\",\"fridgeSet\":2.5}\ns\n"
        );
        assert_eq!(
            settings_command(&json!({"mode":"o"})),
            "j{\"mode\":\"o\"}\ns\n"
        );
    }
    #[tokio::test]
    async fn tcp_frame_exchange() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (s, _) = listener.accept().await.unwrap();
            let mut r = BufReader::new(s);
            let mut cmd = String::new();
            r.read_line(&mut cmd).await.unwrap();
            assert_eq!(cmd, "t\n");
            r.get_mut()
                .write_all(b"D:debug\nT:{\"bt\":19.4}\n")
                .await
                .unwrap();
        });
        assert_eq!(
            parse_temperature(&exchange("127.0.0.1", port, "t\n", "T:").await.unwrap()).unwrap()["beer_temp"],
            19.4
        );
        task.await.unwrap();
    }

    #[tokio::test]
    async fn command_ignores_queued_settings_until_requested_values_arrive() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (s, _) = listener.accept().await.unwrap();
            let mut r = BufReader::new(s);
            let mut cmd = String::new();
            r.read_line(&mut cmd).await.unwrap();
            assert!(cmd.starts_with('j'));
            cmd.clear();
            r.read_line(&mut cmd).await.unwrap();
            assert_eq!(cmd, "s\n");
            // An old command's auto C/S frames can remain after ensure_units.
            r.get_mut().write_all(b"S:{\"mode\":\"o\",\"fridgeSet\":null}\nC:{\"tempFormat\":\"C\"}\nD:changed\nS:{\"mode\":\"f\",\"fridgeSet\":2.0}\nS:{\"mode\":\"f\",\"fridgeSet\":2.5}\n").await.unwrap();
        });
        let d = db::Entity {
            id: format!("queued-settings-{port}"),
            kind: "devices".into(),
            name: "fixture".into(),
            data: json!({"host":"127.0.0.1","port":port}),
        };
        let wanted = json!({"mode":"f","fridgeSet":2.5});
        let reply = exchange_device_confirmed(&d, &format!("j{wanted}\ns\n"), "S:", Some(&wanted))
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(reply.trim_start_matches("S:")).unwrap()["fridgeSet"],
            2.5
        );
        release(&d.id).await;
        task.await.unwrap();
    }

    #[tokio::test]
    async fn command_does_not_confirm_when_only_old_values_are_returned() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (s, _) = listener.accept().await.unwrap();
            let mut r = BufReader::new(s);
            let mut cmd = String::new();
            r.read_line(&mut cmd).await.unwrap();
            r.read_line(&mut cmd).await.unwrap();
            r.get_mut()
                .write_all(
                    b"S:{\"mode\":\"o\",\"fridgeSet\":null}\n"
                        .repeat(32)
                        .as_slice(),
                )
                .await
                .unwrap();
        });
        let d = db::Entity {
            id: format!("rejected-settings-{port}"),
            kind: "devices".into(),
            name: "fixture".into(),
            data: json!({"host":"127.0.0.1","port":port}),
        };
        let wanted = json!({"mode":"f","fridgeSet":2.5});
        assert!(
            exchange_device_confirmed(&d, &format!("j{wanted}\ns\n"), "S:", Some(&wanted))
                .await
                .is_err()
        );
        release(&d.id).await;
        task.await.unwrap();
    }
}

#[derive(Deserialize)]
pub struct AssignProfile {
    profile: Option<String>,
    confirm_ownership: bool,
    start_at: Option<i64>,
}
pub async fn assign_profile(
    State(a): State<App>,
    Path(id): Path<String>,
    Json(v): Json<AssignProfile>,
) -> Result<Json<Value>, ApiError> {
    let operation = operation(&id);
    let _guard = operation.lock().await;
    if !a.control || !a.collection || !v.confirm_ownership {
        return Err(ApiError::bad(
            "Server collection, control and explicit controller ownership are required",
        ));
    }
    a.db.run(move |c| {
        let mut e = db::get(c, &id)?;
        anyhow::ensure!(
            e.kind == "devices" && e.data["collection_enabled"] == true,
            "Enable collection on this device first"
        );
        let now = chrono::Utc::now().timestamp_millis();
        let start = v.start_at.unwrap_or(now);
        e.data["profile_run"] = Value::Null;
        if let Some(ref pid) = v.profile {
            let p = db::get(c, pid)?;
            anyhow::ensure!(p.kind == "profiles", "Not a profile");
            db::validate(&p)?;
            crate::profiles::target(&p.data, 0.0, e.data["unit"].as_str().unwrap_or("C"))?;
            if crate::gravity_profile::conditional(&p.data) {
                let sensor = db::get(c, p.data["gravity_sensor"].as_str().unwrap())?;
                anyhow::ensure!(sensor.kind == "sensors", "Choose a gravity sensor");
                anyhow::ensure!(
                    p.data["gravity_readings"] != "ispindel"
                        || (sensor.data["sensor_type"] == "ispindel"
                            && sensor.data["collection_enabled"] == true),
                    "Enable collection on the selected iSpindel"
                );
                e.data["profile_run"] = crate::gravity_profile::initial(&p.data, start);
            }
        }
        e.data["profile"] = json!(v.profile);
        anyhow::ensure!(
            v.start_at.is_none() || start >= now && start <= now + 366 * 86400000_i64,
            "Scheduled start must be in the next 366 days"
        );
        e.data["profile_started"] = json!(start);
        e.data["control_claimed"] = json!(true);
        db::put(c, &e)
    })
    .await?;
    Ok(Json(json!({"assigned":true})))
}
async fn profile_tick(a: &App, d: &db::Entity) -> Result<()> {
    let operation = operation(&d.id);
    let _guard = operation.lock().await;
    let id = d.id.clone();
    let current = a.db.run(move |c| db::get(c, &id)).await?;
    if current.data["control_claimed"] != true || !current.data["profile"].is_string() {
        return Ok(());
    }
    let d = &current;
    let pid = d.data["profile"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing profile"))?
        .to_string();
    let mut p = a.db.run(move |c| db::get(c, &pid)).await?;
    if d.data["profile_run"].is_object() {
        p.data = d.data["profile_run"]["profile"].clone();
    }
    let started = d.data["profile_started"]
        .as_i64()
        .ok_or_else(|| anyhow::anyhow!("Missing start time"))?;
    let now = chrono::Utc::now().timestamp_millis();
    let Some(elapsed) = crate::profiles::elapsed_since(started, now) else {
        return Ok(());
    };
    let conditional = crate::gravity_profile::conditional(&p.data);
    let (temp, off) = if conditional {
        anyhow::ensure!(
            d.data["profile_run"].is_object(),
            "Restart this profile to enable gravity conditions"
        );
        let id = d.id.clone();
        a.db.run(move |c| {
            let tx = c.transaction()?;
            let mut d = db::get(&tx, &id)?;
            let unit = d.data["unit"].as_str().unwrap_or("C").to_string();
            let result = crate::gravity_profile::tick(&tx, &mut d, now, &unit)?;
            tx.commit()?;
            Ok(result)
        })
        .await?
    } else {
        (
            crate::profiles::target(&p.data, elapsed, d.data["unit"].as_str().unwrap_or("C"))?,
            crate::profiles::completion_off(&p.data, elapsed),
        )
    };
    if off {
        let requested = json!({"mode":"o"});
        let reply =
            exchange_device_confirmed(d, &settings_command(&requested), "S:", Some(&requested))
                .await?;
        let actual: Value = serde_json::from_str(reply.trim_start_matches("S:"))?;
        anyhow::ensure!(actual["mode"] == "o", "Profile completion not confirmed");
        let id = d.id.clone();
        a.db.run(move |c| {
            let mut e = db::get(c, &id)?;
            e.data["profile"] = Value::Null;
            e.data["profile_started"] = Value::Null;
            db::put(c, &e)
        })
        .await?;
        return Ok(());
    }
    let mode = if p.data["control_sensor"] == "chamber" {
        "f"
    } else {
        "b"
    };
    let key = if mode == "f" { "fridgeSet" } else { "beerSet" };

    let check = exchange_device(d, "s\n", "S:").await?;
    let actual: Value = serde_json::from_str(check.trim_start_matches("S:"))?;
    if actual["mode"] == mode
        && actual[key]
            .as_f64()
            .is_some_and(|n| (n - temp).abs() < 0.02)
    {
        return profile_ack(a, &d.id, conditional).await;
    }
    let bounds = if d.data["unit"] == "F" {
        (-4.0, 122.0)
    } else {
        (-20.0, 50.0)
    };
    anyhow::ensure!(
        (bounds.0..=bounds.1).contains(&temp),
        "Profile temperature out of allowed range"
    );
    let requested = json!({"mode":mode,key:temp});
    let reply =
        exchange_device_confirmed(d, &settings_command(&requested), "S:", Some(&requested)).await?;
    let actual: Value = serde_json::from_str(reply.trim_start_matches("S:"))?;
    anyhow::ensure!(
        actual["mode"] == mode
            && actual[key]
                .as_f64()
                .is_some_and(|n| (n - temp).abs() < 0.02),
        "Profile command not confirmed"
    );
    profile_ack(a, &d.id, conditional).await
}
async fn profile_ack(a: &App, id: &str, conditional: bool) -> Result<()> {
    let id = id.to_owned();
    a.db.run(move |c| {
        let mut d = db::get(c, &id)?;
        d.data["profile_error"] = Value::Null;
        if conditional {
            d.data["profile_run"]["applied"] = json!(true);
        }
        db::put(c, &d)
    })
    .await
}

// SPDX-License-Identifier: GPL-3.0-only
//! Batch-gated Custom Stream delivery under the equipment's real name.
use crate::{
    ApiError, App,
    credential_store::{self, Credentials},
    db::{self, Entity},
};
use anyhow::{Context, Result, ensure};
use axum::{
    Json,
    extract::{Path, State},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{sync::OnceLock, time::Duration};
use tokio::sync::Mutex;
const SERVICE: &str = "brewfather_stream";
const INTERVAL: i64 = 900_000;
static OPERATION: OnceLock<Mutex<()>> = OnceLock::new();
pub(crate) fn operation() -> &'static Mutex<()> {
    OPERATION.get_or_init(|| Mutex::new(()))
}
fn unavailable() -> ApiError {
    ApiError::bad(
        "Custom Stream is not configured or cannot be unlocked. Check Brewfather settings.",
    )
}
fn token(url: &str) -> Result<String> {
    let u =
        reqwest::Url::parse(url).context("Enter the HTTPS Custom Stream URL from Brewfather")?;
    ensure!(
        u.scheme() == "https"
            && u.host_str() == Some("log.brewfather.net")
            && u.port().is_none()
            && u.path() == "/stream"
            && u.username().is_empty()
            && u.password().is_none()
            && u.fragment().is_none(),
        "Use https://log.brewfather.net/stream?id=… from Brewfather settings"
    );
    let q: Vec<_> = u.query_pairs().collect();
    ensure!(
        q.len() == 1 && q[0].0 == "id",
        "The URL must contain only its logging ID"
    );
    let id = q[0].1.to_string();
    ensure!(
        !id.is_empty()
            && id.len() <= 256
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "Invalid logging ID"
    );
    Ok(id)
}
fn credentials(a: &App) -> Result<Option<Credentials>> {
    credential_store::load_named(&a.db, &credential_store::key_path(&a.db), SERVICE)
}
fn connection_value(a: &App) -> Value {
    match credentials(a) {
        Ok(v) => {
            json!({"configured":v.is_some(),"encrypted":v.is_some(),"exports_enabled":a.exports})
        }
        Err(_) => json!({"configured":false,"needs_reconnect":true,"exports_enabled":a.exports}),
    }
}
pub async fn connection(State(a): State<App>) -> Json<Value> {
    Json(connection_value(&a))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StreamInput {
    url: String,
}
pub async fn configure(
    State(a): State<App>,
    Json(v): Json<StreamInput>,
) -> Result<Json<Value>, ApiError> {
    let id = token(v.url.trim())
        .map_err(|_| ApiError::bad("Enter a valid HTTPS Brewfather Custom Stream URL."))?;
    let _guard = operation().lock().await;
    a.db.run(|c| {
        c.execute("UPDATE entities SET data=json_set(data,'$.brewfather_export.enabled',json('false')) WHERE kind='batches' AND json_type(data,'$.brewfather_export')='object'",[])?;
        Ok(())
    }).await?;
    credential_store::store_named(
        &a.db,
        &credential_store::key_path(&a.db),
        SERVICE,
        &Credentials {
            user_id: SERVICE.into(),
            api_key: id,
        },
    )
    .map_err(|_| unavailable())?;
    Ok(Json(connection_value(&a)))
}
pub async fn disconnect(State(a): State<App>) -> Result<Json<Value>, ApiError> {
    let _guard = operation().lock().await;
    credential_store::remove_named(&a.db, SERVICE).map_err(|_| unavailable())?;
    a.db.run(|c| {
        let tx=c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute("UPDATE entities SET data=json_set(data,'$.brewfather_export.enabled',json('false')) WHERE kind='batches' AND json_type(data,'$.brewfather_export')='object'",[])?;
        tx.commit()?;Ok(())
    }).await?;
    Ok(Json(connection_value(&a)))
}
fn equipment(c: &Connection, b: &Entity) -> Result<Entity> {
    let id = b.data["device"]
        .as_str()
        .or(b.data["sensor"].as_str())
        .context("Choose equipment for this batch")?;
    let e = db::get(c, id)?;
    ensure!(
        matches!(e.kind.as_str(), "devices" | "sensors"),
        "Invalid equipment"
    );
    Ok(e)
}
fn status_value(c: &Connection, b: &Entity) -> Result<Value> {
    ensure!(
        b.kind == "batches" && b.data["brewfather"]["id"].is_string(),
        "Choose a Brewfather-linked batch"
    );
    let e = equipment(c, b)?;
    let mut value = b.data["brewfather_export"].clone();
    if !value.is_object() {
        value = json!({"enabled":false});
    }
    value["device_name"] = json!(e.name);
    value["active"] = json!(b.data["status"] == "active");
    Ok(value)
}
pub async fn status(State(a): State<App>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let mut v =
        a.db.run(move |c| status_value(c, &db::get(c, &id)?))
            .await?;
    v["connection"] = connection_value(&a);
    Ok(Json(v))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Choice {
    enabled: bool,
}
pub async fn enable(
    State(a): State<App>,
    Path(id): Path<String>,
    Json(v): Json<Choice>,
) -> Result<Json<Value>, ApiError> {
    let _guard = operation().lock().await;
    if v.enabled {
        if !a.exports {
            return Err(ApiError::bad("Exports are disabled on this server"));
        }
        if credentials(&a).map_err(|_| unavailable())?.is_none() {
            return Err(unavailable());
        }
    }
    let mut value =
        a.db.run(move |c| {
            let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let mut b = db::get(&tx, &id)?;
            let mut state = status_value(&tx, &b)?;
            ensure!(
                !v.enabled || b.data["status"] == "active",
                "Only active batches can send readings"
            );
            if v.enabled {
                let name = equipment(&tx, &b)?.name;
                for other in db::list(&tx, "batches")? {
                    if other.id != id
                        && other.data["status"] == "active"
                        && other.data["brewfather_export"]["enabled"] == true
                    {
                        ensure!(
                            equipment(&tx, &other)?.name != name,
                            "This equipment name is already sending for another active batch"
                        );
                    }
                }
                for target in db::list(&tx, "integrations")? {
                    if target.data["enabled"] == true && target.data["type"] == "brewfather" {
                        let source = target.data["source"]
                            .as_str()
                            .or(target.data["device"].as_str())
                            .unwrap_or("");
                        if let Ok(e) = db::get(&tx, source) {
                            ensure!(
                                e.name != name,
                                "Stop the separate Brewfather export for this equipment first"
                            );
                        }
                    }
                }
            }
            state["enabled"] = json!(v.enabled);
            b.data["brewfather_export"] = state.clone();
            db::put(&tx, &b)?;
            tx.commit()?;
            Ok(state)
        })
        .await?;
    value["connection"] = connection_value(&a);
    Ok(Json(value))
}
fn fresh(time: Option<i64>, now: i64, age: i64, start: i64) -> bool {
    time.is_some_and(|t| t >= start && t <= now && now - t <= age)
}
fn temperature(out: &mut Value, key: &str, value: &Value, unit: &str) {
    if let Some(v) = value
        .as_f64()
        .and_then(|v| crate::sensors::convert(v, unit, "C").ok())
        .filter(|v| (-50.0..=100.0).contains(v))
    {
        out[key] = json!(v);
    }
}
pub(crate) fn payload(c: &Connection, b: &Entity, now: i64) -> Result<Value> {
    ensure!(b.data["status"] == "active", "Batch is not active");
    let start = chrono::DateTime::parse_from_rfc3339(
        b.data["created"].as_str().context("Missing batch start")?,
    )?
    .timestamp_millis();
    let e = equipment(c, b)?;
    let mut out =
        json!({"name":e.name,"report_source":"YeastCraft","temp_unit":"C","gravity_unit":"G"});
    let mut has_value = false;
    if e.kind == "devices"
        && e.data["collection_enabled"] == true
        && fresh(e.data["last_seen"].as_i64(), now, 120_000, start)
    {
        let v = &e.data["last_values"];
        let unit = v["temp_format"].as_str().unwrap_or("C");
        for (key, field) in [
            ("temp", "beer_temp"),
            ("aux_temp", "fridge_temp"),
            ("ext_temp", "room_temp"),
        ] {
            temperature(&mut out, key, &v[field], unit);
        }
        has_value = ["temp", "aux_temp", "ext_temp"]
            .iter()
            .any(|k| out[*k].is_number());
        let target = v
            .get("beer_set")
            .filter(|v| v.is_number())
            .unwrap_or(&v["fridge_set"]);
        temperature(&mut out, "temp_target", target, unit);
        out["device_state"] = json!(match v["state"].as_i64() {
            Some(3 | 9) => "heating",
            Some(4 | 8) => "cooling",
            _ => "idle",
        });
    }
    if let Some(id) = b.data["sensor"].as_str() {
        let sensor = db::get(c, id)?;
        let a = &sensor.data["last_automatic"];
        let v = &a["values"];
        if sensor.data["collection_enabled"] == true
            && sensor.data["sensor_type"] == "ispindel"
            && v["reading_source"] == "ispindel"
            && v["origin"] != "brewfather"
            && fresh(a["time"].as_i64(), now, 3_600_000, start)
        {
            if let Some(g) = v["gravity"].as_f64().filter(|g| (0.5..=2.).contains(g)) {
                out["gravity"] = json!(g);
                has_value = true;
            }
            if !out["temp"].is_number() {
                temperature(
                    &mut out,
                    "temp",
                    &v["gravity_temp"],
                    v["temp_format"].as_str().unwrap_or("C"),
                );
                has_value |= out["temp"].is_number();
            }
        }
    }
    ensure!(has_value, "No fresh equipment measurements to send");
    Ok(out)
}
fn reserve(c: &mut Connection, id: &str, now: i64) -> Result<Option<Value>> {
    let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut b = db::get(&tx, id)?;
    if b.data["status"] != "active" || b.data["brewfather_export"]["enabled"] != true {
        return Ok(None);
    }
    let name = equipment(&tx, &b)?.name;
    let next: Option<i64> = tx
        .query_row(
            "SELECT next_attempt FROM brewfather_delivery WHERE name=?",
            [&name],
            |r| r.get(0),
        )
        .optional()?;
    if next.is_some_and(|t| now < t) {
        return Ok(None);
    }
    let data = match payload(&tx, &b, now) {
        Ok(v) => v,
        Err(_) => {
            b.data["brewfather_export"]["error"] = json!("Waiting for fresh equipment readings");
            db::put(&tx, &b)?;
            tx.commit()?;
            return Ok(None);
        }
    };
    // Persist before sending: restart/timeout never immediately repeats a POST.
    tx.execute("INSERT INTO brewfather_delivery(name,next_attempt) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET next_attempt=excluded.next_attempt",params![name,now+INTERVAL])?;
    b.data["brewfather_export"]["last_attempt"] = json!(now);
    b.data["brewfather_export"]["next_attempt"] = json!(now + INTERVAL);
    b.data["brewfather_export"]["error"] = Value::Null;
    db::put(&tx, &b)?;
    tx.commit()?;
    Ok(Some(data))
}
async fn send(client: &reqwest::Client, url: &str, data: &Value) -> (bool, i64, String) {
    let mut response = match client.post(url).json(data).send().await {
        Ok(response) => response,
        Err(error) => {
            return (
                false,
                INTERVAL,
                if error.is_timeout() {
                    "Connection timed out".into()
                } else if error.is_connect() {
                    "Could not connect securely".into()
                } else {
                    "Request failed".into()
                },
            );
        }
    };
    let retry = response
        .headers()
        .get("Retry-After")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0)
        .clamp(0, 86400)
        * 1000;
    if !response.status().is_success() {
        return (
            false,
            retry.max(INTERVAL),
            format!("Brewfather returned HTTP {}", response.status().as_u16()),
        );
    }
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if body.len() + chunk.len() <= 4096 => body.extend_from_slice(&chunk),
            Ok(None) => break,
            _ => return (false, INTERVAL, "Invalid or oversized reply".into()),
        }
    }
    (
        serde_json::from_slice::<Value>(&body)
            .ok()
            .is_some_and(|v| v["result"] == "OK"),
        INTERVAL,
        "Brewfather did not acknowledge the reading".into(),
    )
}
async fn deliver(a: &App, id: &str, client: &reqwest::Client) -> Result<()> {
    let _guard = operation().lock().await;
    if !a.exports {
        return Ok(());
    }
    let Some(secret) = credentials(a)? else {
        return Ok(());
    };
    let local = id.to_owned();
    let now = chrono::Utc::now().timestamp_millis();
    let Some(data) = a.db.run(move |c| reserve(c, &local, now)).await? else {
        return Ok(());
    };
    let mut url = reqwest::Url::parse("https://log.brewfather.net/stream")?;
    url.query_pairs_mut().append_pair("id", &secret.api_key);
    let (success, delay, reason) = send(client, url.as_str(), &data).await;
    let id = id.to_owned();
    let name = data["name"].as_str().unwrap().to_owned();
    a.db.run(move |c| {
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut b = db::get(&tx, &id)?;
        let end = chrono::Utc::now().timestamp_millis();
        let next = end + delay;
        tx.execute(
            "UPDATE brewfather_delivery SET next_attempt=? WHERE name=?",
            params![next, name],
        )?;
        b.data["brewfather_export"]["next_attempt"] = json!(next);
        b.data["brewfather_export"]["error"] = if success {
            Value::Null
        } else {
            json!(format!(
                "{reason}. Will retry after the reporting interval."
            ))
        };
        if success {
            b.data["brewfather_export"]["last_success"] = json!(end);
        }
        db::put(&tx, &b)?;
        tx.commit()?;
        Ok(())
    })
    .await
}
pub async fn worker(a: App) {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .expect("Stream HTTP client");
    loop {
        let batches =
            a.db.run(|c| db::list(c, "batches"))
                .await
                .unwrap_or_default();
        for b in batches {
            if b.data["status"] == "active" && b.data["brewfather_export"]["enabled"] == true {
                let _ = deliver(&a, &b.id, &client).await;
            }
        }
        tokio::time::sleep(Duration::from_secs(15)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, db::Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = db::Db::init(dir.path().join("stream.sqlite")).unwrap();
        let c = db.open().unwrap();
        for e in [
            Entity {
                id: "d".into(),
                kind: "devices".into(),
                name: "Lilla Kylen".into(),
                data: json!({"collection_enabled":true,"last_seen":2000,"last_values":{"beer_temp":68,"fridge_temp":32,"room_temp":77,"beer_set":68,"temp_format":"F","state":4}}),
            },
            Entity {
                id: "s".into(),
                kind: "sensors".into(),
                name: "iSpindel".into(),
                data: json!({"sensor_type":"ispindel","collection_enabled":true,"last_automatic":{"time":2000,"values":{"reading_source":"ispindel","gravity":1.04,"gravity_temp":20,"temp_format":"C"}},"last_values":{"gravity":1.032,"reading_source":"manual","origin":"brewfather"}}),
            },
            Entity {
                id: "b".into(),
                kind: "batches".into(),
                name: "A batch".into(),
                data: json!({"status":"active","device":"d","sensor":"s","created":"1970-01-01T00:00:01Z","brewfather":{"id":"remote","number":44},"brewfather_export":{"enabled":true}}),
            },
        ] {
            db::put(&c, &e).unwrap();
        }
        (dir, db)
    }
    #[test]
    fn payload_uses_real_equipment_name_and_only_fresh_automatic_measurements() {
        let (_dir, db) = setup();
        let c = db.open().unwrap();
        let mut b = db::get(&c, "b").unwrap();
        let p = payload(&c, &b, 3000).unwrap();
        assert_eq!(p["name"], "Lilla Kylen");
        assert_eq!(p["temp"], 20.);
        assert_eq!(p["aux_temp"], 0.);
        assert_eq!(p["ext_temp"], 25.);
        assert_eq!(p["gravity"], 1.04);
        assert_eq!(p["device_state"], "cooling");
        b.name = "Different recipe".into();
        assert_eq!(payload(&c, &b, 3000).unwrap()["name"], "Lilla Kylen");
        let mut sensor = db::get(&c, "s").unwrap();
        sensor.data["last_automatic"]["values"]["reading_source"] = json!("manual");
        db::put(&c, &sensor).unwrap();
        assert!(payload(&c, &b, 3000).unwrap().get("gravity").is_none());
        sensor.data["last_automatic"]["values"]["reading_source"] = json!("ispindel");
        sensor.data["last_automatic"]["time"] = json!(999);
        db::put(&c, &sensor).unwrap();
        assert!(payload(&c, &b, 3000).unwrap().get("gravity").is_none());
        sensor.data["last_automatic"]["time"] = json!(4000);
        db::put(&c, &sensor).unwrap();
        assert!(payload(&c, &b, 3000).unwrap().get("gravity").is_none());
        assert!(payload(&c, &b, 4_000_000).is_err());
        sensor.data["last_automatic"]["time"] = json!(2000);
        db::put(&c, &sensor).unwrap();
        b.data["device"] = Value::Null;
        assert_eq!(payload(&c, &b, 3000).unwrap()["name"], "iSpindel");
    }
    #[test]
    fn restart_batch_switch_and_reenable_do_not_bypass_device_interval() {
        let (_dir, db) = setup();
        let mut c = db.open().unwrap();
        assert!(reserve(&mut c, "b", 3000).unwrap().is_some());
        drop(c);
        let mut c = db.open().unwrap();
        assert!(reserve(&mut c, "b", 4000).unwrap().is_none());
        let mut b = db::get(&c, "b").unwrap();
        b.data["status"] = json!("completed");
        db::put(&c, &b).unwrap();
        assert!(reserve(&mut c, "b", 1_000_000).unwrap().is_none());
        b.id = "next".into();
        b.data["status"] = json!("active");
        db::put(&c, &b).unwrap();
        assert!(reserve(&mut c, "next", 5000).unwrap().is_none());
        let mut d = db::get(&c, "d").unwrap();
        d.data["last_seen"] = json!(1_000_000);
        db::put(&c, &d).unwrap();
        assert!(reserve(&mut c, "next", 1_000_000).unwrap().is_some());
        b.data["brewfather_export"]["enabled"] = json!(false);
        db::put(&c, &b).unwrap();
        assert!(reserve(&mut c, "next", 2_000_000).unwrap().is_none());
    }
    #[test]
    fn stream_url_is_fixed_host_and_has_no_secret_echo() {
        assert_eq!(
            token("https://log.brewfather.net/stream?id=synthetic-123").unwrap(),
            "synthetic-123"
        );
        for url in [
            "http://log.brewfather.net/stream?id=x",
            "https://evil.example/stream?id=x",
            "https://log.brewfather.net/stream?id=x&next=y",
            "https://user@log.brewfather.net/stream?id=x",
            "https://log.brewfather.net/other?id=x",
            "https://log.brewfather.net/stream?id=x#bad",
            "https://log.brewfather.net/stream?id=x&id=y",
        ] {
            assert!(token(url).is_err());
        }
    }
    #[tokio::test]
    async fn only_confirmed_json_ack_counts_and_redirects_are_not_followed() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (code, body, retry, ok) in [
            (200, "{\"result\":\"OK\"}", "0", true),
            (200, "{\"result\":\"ignored\"}", "0", false),
            (302, "redirect", "0", false),
            (429, "rate limited", "3600", false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/stream", listener.local_addr().unwrap());
            let task = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = [0; 4096];
                let n = socket.read(&mut bytes).await.unwrap();
                assert!(String::from_utf8_lossy(&bytes[..n]).starts_with("POST /stream "));
                socket.write_all(format!("HTTP/1.1 {code} Test\r\nContent-Length: {}\r\nRetry-After: {retry}\r\nLocation: http://127.0.0.1:1/forbidden\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            });
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap();
            let result = send(&client, &url, &json!({"name":"Lilla Kylen","temp":20})).await;
            assert_eq!(result.0, ok);
            if code == 429 {
                assert_eq!(result.1, 3_600_000);
            }
            task.await.unwrap();
        }
    }
}

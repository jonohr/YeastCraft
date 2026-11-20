// SPDX-License-Identifier: GPL-3.0-only
//! Brewfather reads with encrypted credentials. No upstream writes or controller access.
use crate::{
    ApiError, App,
    credential_store::{self, Credentials},
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    sync::OnceLock,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

const MAX_BODY: usize = 12_000_000;
const MAX_CACHE: usize = 16_000_000;
fn unavailable(message: &str) -> ApiError {
    ApiError(StatusCode::SERVICE_UNAVAILABLE, message.into())
}
fn label(v: &Value) -> String {
    v.as_str().unwrap_or("").chars().take(300).collect()
}
fn number(v: &Value) -> Value {
    if v.is_number() {
        v.clone()
    } else {
        Value::Null
    }
}
fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
struct Cached {
    path: String,
    at: Instant,
    stamp: f64,
    body: Vec<u8>,
}
#[derive(Default)]
struct Client {
    cache: VecDeque<Cached>,
    calls: VecDeque<Instant>,
    blocked: Option<Instant>,
    identity: Option<[u8; 32]>,
    #[cfg(test)]
    test_base: Option<String>,
}
static CLIENT: OnceLock<Mutex<Client>> = OnceLock::new();

fn credentials(a: &App) -> Result<Credentials, ApiError> {
    credential_store::load(&a.db, &credential_store::key_path(&a.db))
        .map_err(|_| unavailable("Cannot unlock Brewfather credentials. Restore the encryption key or disconnect and reconnect."))?
        .ok_or_else(|| unavailable("Brewfather is not connected. Connect in Integrations."))
}
pub async fn connection_status(State(a): State<App>) -> Result<Json<Value>, ApiError> {
    match credential_store::load(&a.db, &credential_store::key_path(&a.db)) {
        Ok(Some(_)) => Ok(Json(json!({"connected":true,"encrypted":true}))),
        Ok(None) => Ok(Json(json!({"connected":false,"encrypted":false}))),
        Err(_) => Ok(Json(
            json!({"connected":false,"encrypted":true,"needs_reconnect":true}),
        )),
    }
}
pub async fn connect(
    State(a): State<App>,
    Json(value): Json<Credentials>,
) -> Result<Json<Value>, ApiError> {
    value
        .validate()
        .map_err(|_| ApiError::bad("Enter a valid User ID and API key."))?;
    let mut client = CLIENT.get_or_init(Default::default).lock().await;
    save_connection(&mut client, &a.db, &value).await?;
    Ok(Json(json!({"connected":true,"encrypted":true})))
}
async fn save_connection(
    client: &mut Client,
    db: &crate::db::Db,
    value: &Credentials,
) -> Result<(), ApiError> {
    verify(client, value).await?;
    credential_store::store(db, &credential_store::key_path(db), value).map_err(|_| {
        unavailable(
            "Could not save the encrypted connection. Check the server encryption key and storage.",
        )
    })?;
    client.cache.clear();
    Ok(())
}

pub async fn test_connection(State(a): State<App>) -> Result<Json<Value>, ApiError> {
    let mut client = CLIENT.get_or_init(Default::default).lock().await;
    let value = credentials(&a)?;
    verify(&mut client, &value).await?;
    Ok(Json(json!({"ok":true,"permission":"batches.read"})))
}
async fn verify(client: &mut Client, value: &Credentials) -> Result<(), ApiError> {
    let (_, rows) = client.get("batches?limit=1", 0, value).await?;
    if !rows.is_array() {
        return Err(unavailable(
            "Unexpected Brewfather response. Connection was not saved.",
        ));
    }
    Ok(())
}
pub async fn disconnect(State(a): State<App>) -> Result<Json<Value>, ApiError> {
    let mut client = CLIENT.get_or_init(Default::default).lock().await;
    credential_store::remove(&a.db).map_err(|_| unavailable("Could not remove the connection."))?;
    client.cache.clear();
    client.identity = None;
    Ok(Json(json!({"connected":false})))
}
impl Client {
    async fn get(
        &mut self,
        path: &str,
        ttl: u64,
        credentials: &Credentials,
    ) -> Result<(f64, Value), ApiError> {
        let identity: [u8; 32] =
            Sha256::digest(format!("{}:{}", credentials.user_id, credentials.api_key)).into();
        if self.identity != Some(identity) {
            self.cache.clear();
            self.identity = Some(identity);
        }

        let now = Instant::now();
        if let Some(c) = self
            .cache
            .iter()
            .find(|c| c.path == path && now.duration_since(c.at).as_secs() < ttl)
        {
            return Ok((
                c.stamp,
                serde_json::from_slice(&c.body)
                    .map_err(|_| unavailable("Invalid cached response."))?,
            ));
        }
        if self.blocked.is_some_and(|until| now < until) {
            return Err(unavailable(
                "Brewfather is temporarily unavailable. Please try again later.",
            ));
        }
        while self
            .calls
            .front()
            .is_some_and(|t| now.duration_since(*t).as_secs() >= 3600)
        {
            self.calls.pop_front();
        }
        if self.calls.len() >= 100 {
            return Err(unavailable(
                "Brewfather request budget reached. Please try again later.",
            ));
        }
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|_| unavailable("Brewfather HTTP client unavailable."))?;
        self.calls.push_back(now);
        // Only callers below construct paths, with validated IDs; never an arbitrary URL.
        let base = "https://api.brewfather.app/v2/";
        #[cfg(test)]
        let base = self.test_base.as_deref().unwrap_or(base);
        let response = http
            .get(format!("{base}{path}"))
            .basic_auth(&credentials.user_id, Some(&credentials.api_key))
            .header("Accept", "application/json")
            .header("User-Agent", "YeastCraft")
            .send()
            .await;
        let mut response = match response {
            Ok(r) => r,
            Err(_) => {
                self.blocked = Some(Instant::now() + Duration::from_secs(30));
                return Err(unavailable(
                    "Could not reach Brewfather. Previous view retained.",
                ));
            }
        };
        if !response.status().is_success() {
            let retry = response
                .headers()
                .get("Retry-After")
                .and_then(|h| h.to_str().ok())
                .and_then(|s| {
                    s.parse::<u64>().ok().or_else(|| {
                        chrono::DateTime::parse_from_rfc2822(s)
                            .ok()
                            .map(|t| (t.timestamp() - chrono::Utc::now().timestamp()).max(0) as u64)
                    })
                })
                .unwrap_or(60)
                .clamp(60, 86400);
            self.blocked = Some(Instant::now() + Duration::from_secs(retry));
            return Err(unavailable(
                if matches!(response.status().as_u16(), 401 | 403) {
                    "Brewfather access denied. Check batches.read permission."
                } else {
                    "Brewfather could not return this data. Please try again later."
                },
            ));
        }
        let body_result = async {
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| {
                unavailable("Incomplete Brewfather response. Previous view retained.")
            })? {
                if body.len() + chunk.len() > MAX_BODY {
                    return Err(unavailable("Brewfather response is too large."));
                }
                body.extend_from_slice(&chunk);
            }
            let value: Value = serde_json::from_slice(&body)
                .map_err(|_| unavailable("Invalid Brewfather response. Previous view retained."))?;
            Ok::<_, ApiError>((body, value))
        }
        .await;
        let (body, value) = match body_result {
            Ok(v) => v,
            Err(e) => {
                self.blocked = Some(Instant::now() + Duration::from_secs(30));
                return Err(e);
            }
        };
        self.cache.retain(|c| c.path != path);
        while self.cache.len() >= 16
            || self.cache.iter().map(|c| c.body.len()).sum::<usize>() + body.len() > MAX_CACHE
        {
            self.cache.pop_front();
        }
        let stamp = chrono::Utc::now().timestamp_millis() as f64 / 1000.;
        self.cache.push_back(Cached {
            path: path.into(),
            at: Instant::now(),
            stamp,
            body,
        });
        Ok((stamp, value))
    }
}
fn select_batch(b: &Value) -> Value {
    let p = &b["recipe"]["fermentation"];
    let steps:Vec<_>=p["steps"].as_array().into_iter().flatten().filter(|s|s.is_object()).map(|s|json!({
        "name":label(s.get("name").filter(|v|v.as_str().is_some_and(|s|!s.is_empty())).unwrap_or(&s["type"])),
        "temperature":number(&s["stepTemp"]),"days":number(&s["stepTime"]),"ramp":number(&s["ramp"]),"pressure":number(&s["pressure"])
    })).collect();
    json!({"id":label(&b["_id"]),"name":label(&b["name"]),"number":number(&b["batchNo"]),"brew_date":number(&b["brewDate"]),"status":label(&b["status"]),"recipe":label(&b["recipe"]["name"]),"og":number(&b["measuredOg"]),"fg":number(&b["measuredFg"]),"profile":{"name":label(&p["name"]),"steps":steps}})
}
fn select_readings(rows: &Value) -> Result<Value, ApiError> {
    let rows = rows
        .as_array()
        .ok_or_else(|| unavailable("Unexpected readings response. Previous view retained."))?;
    let mut result = Vec::with_capacity(rows.len());
    for r in rows {
        if !r.is_object() || r["time"].as_f64().is_none() {
            return Err(unavailable(
                "Invalid reading timestamp. Previous view retained.",
            ));
        }
        result.push(json!({"time":r["time"],"sg":number(&r["sg"]),"temp":number(&r["temp"]),"chamber":number(r.get("fridgeTemp").unwrap_or(&r["aux_temp"])),"room":number(r.get("roomTemp").unwrap_or(&r["ext_temp"])),"type":label(&r["type"]),"source":label(&r["id"])}));
    }
    result.sort_by(|a, b| {
        a["time"]
            .as_f64()
            .unwrap()
            .total_cmp(&b["time"].as_f64().unwrap())
    });
    Ok(json!(result))
}
#[derive(Deserialize)]
pub struct Page {
    #[serde(default)]
    after: String,
}
pub async fn batches(
    State(a): State<App>,
    Query(page): Query<Page>,
) -> Result<Json<Value>, ApiError> {
    if !page.after.is_empty() && !valid_id(&page.after) {
        return Err(ApiError::bad("Invalid page cursor"));
    }
    let path = if page.after.is_empty() {
        "batches?limit=50&order_by=brewDate&order_by_direction=desc&include=measuredOg".into()
    } else {
        format!(
            "batches?limit=50&order_by=brewDate&order_by_direction=desc&include=measuredOg&start_after={}",
            page.after
        )
    };
    let mut client = CLIENT.get_or_init(Default::default).lock().await;
    let credentials = credentials(&a)?;
    let (stamp, data) = client.get(&path, 300, &credentials).await?;
    let rows = data
        .as_array()
        .ok_or_else(|| unavailable("Unexpected batch list response."))?;
    if rows
        .iter()
        .any(|b| !b.is_object() || !valid_id(b["_id"].as_str().unwrap_or("")))
    {
        return Err(unavailable("Invalid batch list response."));
    }
    Ok(Json(
        json!({"batches":rows.iter().map(select_batch).collect::<Vec<_>>(),"next":if rows.len()==50 {rows.last().unwrap()["_id"].clone()}else{Value::Null},"fetched":stamp}),
    ))
}
pub async fn batch(State(a): State<App>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    if !valid_id(&id) {
        return Err(ApiError::bad("Invalid batch ID"));
    }
    let mut client = CLIENT.get_or_init(Default::default).lock().await;
    let credentials = credentials(&a)?;
    let (stamp, b) = client
        .get(
            &format!("batches/{id}?include=recipe.name,recipe.fermentation,measuredOg,measuredFg"),
            60,
            &credentials,
        )
        .await?;
    if b["_id"] != id {
        return Err(unavailable("Unexpected batch response."));
    }
    let (read_stamp, rows) = client
        .get(&format!("batches/{id}/readings"), 60, &credentials)
        .await?;
    let readings = select_readings(&rows)?;
    let candidate = match translate(&b["recipe"]["fermentation"]) {
        Ok(c) => c,
        Err(reason) => json!({"status":"review_required","reason":reason}),
    };
    Ok(Json(
        json!({"batch":select_batch(&b),"readings":readings,"candidate":candidate,"fetched":stamp.min(read_stamp),"history_complete":false,"read_only":true}),
    ))
}
/// Fetch only the start values and profile. No readings or historical import.
pub async fn plan(State(a): State<App>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    if !valid_id(&id) {
        return Err(ApiError::bad("Invalid batch ID"));
    }
    let mut client = CLIENT.get_or_init(Default::default).lock().await;
    let credentials = credentials(&a)?;
    Ok(Json(load_plan(&mut client, &credentials, &id).await?))
}
async fn load_plan(
    client: &mut Client,
    credentials: &Credentials,
    id: &str,
) -> Result<Value, ApiError> {
    let (stamp, b) = client
        .get(
            &format!("batches/{id}?include=recipe.name,recipe.fermentation,measuredOg,measuredFg"),
            60,
            credentials,
        )
        .await?;
    if b["_id"] != id {
        return Err(unavailable("Unexpected batch response."));
    }
    let candidate = match translate(&b["recipe"]["fermentation"]) {
        Ok(c) => c,
        Err(reason) => json!({"status":"review_required","reason":reason}),
    };
    Ok(json!({"batch":select_batch(&b),"candidate":candidate,"fetched":stamp}))
}
fn numeric(v: &Value, field: &str, min: f64, max: f64) -> Result<f64, String> {
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= min && *n <= max)
        .ok_or_else(|| format!("{field} must be a number between {min} and {max}"))
}
fn translate(source: &Value) -> Result<Value, String> {
    let rows = source["steps"]
        .as_array()
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .ok_or("The source profile must have between 1 and 256 steps")?;
    let mut steps = Vec::new();
    let mut warnings = Vec::new();
    let mut total = 0.;
    if source["pressurized"] == true || rows.iter().any(|s| !s["pressure"].is_null()) {
        warnings
            .push("Pressure settings are excluded. YC will control temperature only.".to_string());
    }
    for (i, s) in rows.iter().enumerate() {
        let temp = numeric(
            &s["stepTemp"],
            &format!("Step {} temperature (C)", i + 1),
            -20.,
            50.,
        )?;
        let days = numeric(
            &s["stepTime"],
            &format!("Step {} hold days", i + 1),
            0.,
            365.,
        )?;
        let mut ramp = if s["ramp"].is_null() {
            0.
        } else {
            numeric(&s["ramp"], &format!("Step {} ramp days", i + 1), 0., 365.)?
        };
        let name = s
            .get("name")
            .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
            .or(s.get("type"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("Step {}", i + 1));
        if i == 0 && ramp > 0. {
            warnings.push(format!("First-step ramp omitted ({ramp} days). YC sets {temp} °C immediately and keeps the specified hold time."));
            ramp = 0.;
        }
        if days == 0. && ramp == 0. {
            return Err(format!("Step {} has no duration; review its intent", i + 1));
        }
        if ramp > 0. {
            steps.push(json!({"name":format!("{name} · ramp"),"temperature":temp,"hours":ramp*24.,"transition":"ramp"}));
        }
        if days > 0. {
            steps
                .push(json!({"name":name,"temperature":temp,"hours":days*24.,"transition":"hold"}));
        }
        total += (days + ramp) * 24.;
    }
    Ok(
        json!({"status":"ready","profile":{"unit":"C","control_sensor":"beer","end_behavior":"hold","steps":steps},"total_hours":total,"warnings":warnings}),
    )
}
// Sync is serialized with connection replacement/disconnection and preview reads.
pub(crate) async fn sync_readings(a: &App, local_id: &str) -> Result<Value, ApiError> {
    if !a.collection {
        return Err(ApiError::bad("Collection is disabled"));
    }
    let mut client = CLIENT.get_or_init(Default::default).lock().await;
    sync_with_client(a, local_id, &mut client).await
}
async fn sync_with_client(a: &App, local_id: &str, client: &mut Client) -> Result<Value, ApiError> {
    let local = local_id.to_owned();
    let batch = a.db.run(move |c| crate::db::get(c, &local)).await?;
    let remote = batch.data["brewfather"]["id"].as_str().unwrap_or("");
    if batch.kind != "batches" || batch.data["status"] != "active" || !valid_id(remote) {
        return Err(ApiError::bad("Choose an active Brewfather-linked batch"));
    }
    let now = chrono::Utc::now().timestamp_millis();
    if now
        - batch.data["brewfather_sync"]["last_attempt"]
            .as_i64()
            .unwrap_or(0)
        < 60_000
    {
        return Ok(batch.data["brewfather_sync"].clone());
    }
    let result = async {
        let credentials = credentials(a)?;
        let (_, rows) = client
            .get(&format!("batches/{remote}/readings"), 60, &credentials)
            .await?;
        Ok::<Value, ApiError>(rows)
    }
    .await;
    let remote = remote.to_owned();
    let local = local_id.to_owned();
    // Never persist credentials, upstream bodies or transport errors in status.
    Ok(a.db
        .run(move |c| crate::brewfather_sync::apply(c, &local, &remote, result.ok().as_ref(), now))
        .await?)
}

pub async fn sync_batch(
    State(a): State<App>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(sync_readings(&a, &id).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn connection_save_tests_before_replace_and_does_not_follow_redirects() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let t = tempfile::tempdir().unwrap();
        let db = crate::db::Db::init(t.path().join("test.sqlite")).unwrap();
        let original = Credentials {
            user_id: "before".into(),
            api_key: "original-key".into(),
        };
        credential_store::store(&db, &credential_store::key_path(&db), &original).unwrap();
        for status in [401, 302, 200] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let n = socket.read(&mut request).await.unwrap();
                assert!(
                    String::from_utf8_lossy(&request[..n]).starts_with("GET /batches?limit=1 ")
                );
                let body = if status == 200 {
                    "[]"
                } else {
                    "do-not-expose-upstream-body"
                };
                socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nLocation: http://127.0.0.1:1/forbidden\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            });
            let mut client = Client {
                test_base: Some(base),
                ..Client::default()
            };
            let replacement = Credentials {
                user_id: "after".into(),
                api_key: "replacement-key".into(),
            };
            let result = save_connection(&mut client, &db, &replacement).await;
            server.await.unwrap();
            let stored = credential_store::load(&db, &credential_store::key_path(&db))
                .unwrap()
                .unwrap();
            if status == 200 {
                assert!(result.is_ok());
                assert_eq!(stored.api_key, "replacement-key");
                assert!(client.cache.is_empty());
            } else {
                let error = result.err().unwrap().1;
                assert!(!error.contains("do-not-expose"));
                assert_eq!(stored.api_key, "original-key");
            }
        }
    }
    #[tokio::test]
    async fn sync_fetches_only_readings_and_throttles_duplicate_requests() {
        use std::sync::{Arc, Mutex as StdMutex};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let dir = tempfile::tempdir().unwrap();
        let a = App {
            db: crate::db::Db::init(dir.path().join("sync.sqlite")).unwrap(),
            secure_cookie: false,
            proxy_proof: None,
            import_root: Arc::new(dir.path().into()),
            collection: true,
            control: false,
            exports: false,
            failures: Arc::new(StdMutex::new(Default::default())),
            auth_slots: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        let creds = Credentials {
            user_id: "synthetic".into(),
            api_key: "synthetic".into(),
        };
        credential_store::store(&a.db, &credential_store::key_path(&a.db), &creds).unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        crate::db::put(&a.db.open().unwrap(),&crate::db::Entity{id:"local".into(),kind:"batches".into(),name:"Synthetic".into(),data:json!({"status":"active","created":"2026-01-01T00:00:00Z","brewfather":{"id":"remote"}})}).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = Client {
            test_base: Some(format!("http://{}/", listener.local_addr().unwrap())),
            ..Client::default()
        };
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0; 4096];
            let n = socket.read(&mut buf).await.unwrap();
            assert!(
                String::from_utf8_lossy(&buf[..n]).starts_with("GET /batches/remote/readings ")
            );
            let body =
                json!([{"time":now-1000,"sg":1.033,"type":"manual","id":"manual"}]).to_string();
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let result = sync_with_client(&a, "local", &mut client)
            .await
            .unwrap_or_else(|e| panic!("{}", e.1));
        assert_eq!(result["latest"]["sg"], 1.033);
        server.await.unwrap();
        let again = sync_with_client(&a, "local", &mut client)
            .await
            .unwrap_or_else(|e| panic!("{}", e.1));
        assert_eq!(again, result);
        assert_eq!(client.calls.len(), 1);
        assert_eq!(
            crate::db::points(&a.db.open().unwrap(), "local", 100)
                .unwrap()
                .len(),
            1
        );
    }
    #[tokio::test]
    async fn start_plan_only_fetches_profile_and_projects_start_values() {
        let credentials = Credentials {
            user_id: "fake".into(),
            api_key: "fake".into(),
        };
        let mut client = Client {
            identity: Some(Sha256::digest(b"fake:fake").into()),
            test_base: Some("http://127.0.0.1:1/".into()),
            ..Client::default()
        };
        let body = json!({"_id":"sample", "name":"New beer", "measuredOg":1.05, "brewDate":1234, "private":"must-not-escape", "recipe":{"fermentation":{"steps":[{"stepTemp":18,"stepTime":2}]}}});
        client.cache.push_back(Cached {
            path: "batches/sample?include=recipe.name,recipe.fermentation,measuredOg,measuredFg"
                .into(),
            at: Instant::now(),
            stamp: 123.,
            body: serde_json::to_vec(&body).unwrap(),
        });
        // Any extra fetch (including readings) fails: the request budget is full.
        client.calls = std::iter::repeat_n(Instant::now(), 100).collect();
        let plan = load_plan(&mut client, &credentials, "sample")
            .await
            .unwrap_or_else(|_| panic!("plan must not fetch history"));
        assert_eq!(plan["batch"]["og"], 1.05);
        assert_eq!(plan["batch"]["brew_date"], 1234);
        assert_eq!(plan["candidate"]["profile"]["steps"][0]["hours"], 48.);
        assert!(plan.get("readings").is_none());
        assert!(!plan.to_string().contains("must-not-escape"));
    }
    #[tokio::test]
    async fn cache_and_budget_do_not_call_upstream() {
        let now = Instant::now();
        let credentials = Credentials {
            user_id: "fake".into(),
            api_key: "fake".into(),
        };
        let mut c = Client {
            identity: Some(Sha256::digest(b"fake:fake").into()),
            test_base: Some("http://127.0.0.1:1/".into()),
            ..Client::default()
        };
        c.cache.push_back(Cached {
            path: "batches?limit=50&order_by=brewDate&order_by_direction=desc&include=measuredOg"
                .into(),
            at: now,
            stamp: 123.,
            body: b"[]".to_vec(),
        });
        let (stamp, rows) = c
            .get(
                "batches?limit=50&order_by=brewDate&order_by_direction=desc&include=measuredOg",
                300,
                &credentials,
            )
            .await
            .unwrap_or_else(|_| panic!("cached request failed"));
        assert_eq!(stamp, 123.);
        assert_eq!(rows, json!([]));
        assert!(c.calls.is_empty());
        c.calls = std::iter::repeat_n(now, 100).collect();
        assert!(
            c.get("uncached", 60, &credentials)
                .await
                .err()
                .unwrap()
                .1
                .contains("budget")
        );
        c.blocked = Some(now + Duration::from_secs(60));
        assert!(
            c.get("uncached", 60, &credentials)
                .await
                .err()
                .unwrap()
                .1
                .contains("temporarily")
        );
    }
    #[test]
    fn translated_schedule_matches_actual_yc_evaluator() {
        let c=translate(&json!({"steps":[{"stepTemp":18,"stepTime":2},{"stepTemp":20,"stepTime":3,"ramp":1},{"stepTemp":5,"stepTime":2}]})).unwrap();
        let p = &c["profile"];
        for (h, t) in [
            (0., 18.),
            (47., 18.),
            (48., 18.),
            (60., 19.),
            (72., 20.),
            (143., 20.),
            (144., 5.),
            (192., 5.),
        ] {
            assert_eq!(crate::profiles::target(p, h, "C").unwrap(), t);
        }
        assert!(!crate::profiles::completion_off(p, 192.));
        let mut off = p.clone();
        off["end_behavior"] = json!("off");
        assert!(!crate::profiles::completion_off(&off, 191.));
        assert!(crate::profiles::completion_off(&off, 192.));
    }
    #[test]
    fn additive_ramps_and_initial_adjustment() {
        let source = json!({"steps":[{"stepTemp":18,"stepTime":3,"ramp":1,"pressure":12},{"stepTemp":20,"stepTime":3,"ramp":1},{"stepTemp":5,"stepTime":3}]});
        let c = translate(&source).unwrap();
        assert_eq!(c["total_hours"], 240.);
        assert_eq!(c["profile"]["steps"].as_array().unwrap().len(), 4);
        assert_eq!(c["warnings"].as_array().unwrap().len(), 2);
        assert_eq!(c["profile"]["steps"][1]["transition"], "ramp");
        assert_eq!(source["steps"][0]["ramp"], 1);
    }
    #[test]
    fn rejects_invalid_and_zero_steps() {
        for v in [Value::Null, json!(true), json!("2"), json!(-1), json!(366)] {
            assert!(translate(&json!({"steps":[{"stepTemp":18,"stepTime":v}]})).is_err());
        }
        assert!(translate(&json!({"steps":[{"stepTemp":18,"stepTime":0,"ramp":1}]})).is_err());
        assert!(translate(&json!({"steps":[{"stepTemp":51,"stepTime":1}]})).is_err());
    }
    #[test]
    fn fractional_and_ramp_only() {
        let c=translate(&json!({"steps":[{"stepTemp":18,"stepTime":0.25},{"stepTemp":5,"stepTime":0,"ramp":0.5}]})).unwrap();
        assert_eq!(c["total_hours"], 18.);
        assert_eq!(c["profile"]["steps"][1]["hours"], 12.);
    }
    #[test]
    fn projection_excludes_secrets_and_keeps_missing() {
        let b = select_batch(
            &json!({"_id":"abc","measuredOg":1.05,"secret":"hidden","recipe":{"secret":"hidden"}}),
        );
        assert!(!b.to_string().contains("hidden"));
        assert!(b["fg"].is_null());
        assert_eq!(b["og"], 1.05);
    }
    #[test]
    fn readings_sorted_without_merging_or_zero_fill() {
        let stream = select_readings(
            &json!([{"time":3,"type":"stream","temp":19.4,"fridgeTemp":19.3,"roomTemp":24.6}]),
        )
        .unwrap_or_else(|_| panic!("invalid stream fixture"));
        assert_eq!(stream[0]["chamber"], 19.3);
        assert_eq!(stream[0]["room"], 24.6);

        let r=select_readings(&json!([{"time":2,"id":"manual","sg":1.04,"token":"hidden"},{"time":1,"sg":null},{"time":2,"id":"manual","sg":1.03}])).unwrap_or_else(|_|panic!("invalid fixture"));
        assert_eq!(r.as_array().unwrap().len(), 3);
        assert_eq!(r[0]["time"], 1);
        assert!(r[0]["sg"].is_null());
        assert!(!r.to_string().contains("hidden"));
        assert!(select_readings(&json!([{"sg":1.03}])).is_err());
    }
    #[test]
    fn path_validation() {
        for s in [
            "",
            "../abc",
            "abc?include=secret",
            "https://evil",
            "a/b",
            "a%2fb",
        ] {
            assert!(!valid_id(s));
        }
        assert!(valid_id("batch_ABC-123"));
    }
}

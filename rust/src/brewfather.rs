// SPDX-License-Identifier: GPL-3.0-only
//! Read-only Brewfather batch preview. No database or controller access.
use crate::ApiError;
use axum::{
    Json,
    extract::{Path, Query},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::{Value, json};
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
}
static CLIENT: OnceLock<Mutex<Client>> = OnceLock::new();

fn credentials() -> Result<(String, String), ApiError> {
    let path = std::env::var("YEASTCRAFT_BREWFATHER_CREDENTIALS_FILE")
        .map_err(|_| unavailable("Brewfather is not connected. Configure the server credential file with batches.read access."))?;
    let data = std::fs::read_to_string(path)
        .map_err(|_| unavailable("Cannot read the Brewfather server credential file."))?;
    let mut user = None;
    let mut key = None;
    for line in data.lines() {
        if let Some((name, value)) = line.split_once('=') {
            let value = value.trim().trim_matches(['\'', '"']).to_string();
            match name.trim() {
                "BREWFATHER_USER_ID" => user = Some(value),
                "BREWFATHER_API_KEY" => key = Some(value),
                _ => {}
            }
        }
    }
    match (user, key) {
        (Some(u), Some(k)) if !u.is_empty() && !k.is_empty() => Ok((u, k)),
        _ => Err(unavailable("Brewfather server credentials are incomplete.")),
    }
}
impl Client {
    async fn get(&mut self, path: &str, ttl: u64) -> Result<(f64, Value), ApiError> {
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
        let (user, key) = credentials()?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|_| unavailable("Brewfather HTTP client unavailable."))?;
        self.calls.push_back(now);
        // Only callers below construct paths, with validated IDs; never an arbitrary URL.
        let response = http
            .get(format!("https://api.brewfather.app/v2/{path}"))
            .basic_auth(user, Some(key))
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
    json!({"id":label(&b["_id"]),"name":label(&b["name"]),"number":number(&b["batchNo"]),"status":label(&b["status"]),"recipe":label(&b["recipe"]["name"]),"og":number(&b["measuredOg"]),"fg":number(&b["measuredFg"]),"profile":{"name":label(&p["name"]),"steps":steps}})
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
        result.push(json!({"time":r["time"],"sg":number(&r["sg"]),"temp":number(&r["temp"]),"chamber":number(&r["aux_temp"]),"room":number(&r["ext_temp"]),"type":label(&r["type"]),"source":label(&r["id"])}));
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
pub async fn batches(Query(page): Query<Page>) -> Result<Json<Value>, ApiError> {
    if !page.after.is_empty() && !valid_id(&page.after) {
        return Err(ApiError::bad("Invalid page cursor"));
    }
    let path = if page.after.is_empty() {
        "batches?limit=50".into()
    } else {
        format!("batches?limit=50&start_after={}", page.after)
    };
    let (stamp, data) = CLIENT
        .get_or_init(Default::default)
        .lock()
        .await
        .get(&path, 300)
        .await?;
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
pub async fn batch(Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    if !valid_id(&id) {
        return Err(ApiError::bad("Invalid batch ID"));
    }
    let mut client = CLIENT.get_or_init(Default::default).lock().await;
    let (stamp, b) = client
        .get(
            &format!("batches/{id}?include=recipe.name,recipe.fermentation,measuredOg,measuredFg"),
            60,
        )
        .await?;
    if b["_id"] != id {
        return Err(unavailable("Unexpected batch response."));
    }
    let (read_stamp, rows) = client.get(&format!("batches/{id}/readings"), 60).await?;
    let readings = select_readings(&rows)?;
    let candidate = match translate(&b["recipe"]["fermentation"]) {
        Ok(c) => c,
        Err(reason) => json!({"status":"review_required","reason":reason}),
    };
    Ok(Json(
        json!({"batch":select_batch(&b),"readings":readings,"candidate":candidate,"fetched":stamp.min(read_stamp),"history_complete":false,"read_only":true}),
    ))
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
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cache_and_budget_do_not_call_upstream() {
        let now = Instant::now();
        let mut c = Client::default();
        c.cache.push_back(Cached {
            path: "batches?limit=50".into(),
            at: now,
            stamp: 123.,
            body: b"[]".to_vec(),
        });
        let (stamp, rows) = c
            .get("batches?limit=50", 300)
            .await
            .unwrap_or_else(|_| panic!("cached request failed"));
        assert_eq!(stamp, 123.);
        assert_eq!(rows, json!([]));
        assert!(c.calls.is_empty());
        c.calls = std::iter::repeat_n(now, 100).collect();
        assert!(
            c.get("uncached", 60)
                .await
                .err()
                .unwrap()
                .1
                .contains("budget")
        );
        c.blocked = Some(now + Duration::from_secs(60));
        assert!(
            c.get("uncached", 60)
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

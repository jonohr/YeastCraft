// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    ApiError, App,
    db::{self, Entity},
};
use anyhow::{Context, Result};
use axum::{
    Json,
    extract::{Path, State},
};
use serde_json::{Value, json};
use std::time::Duration;
pub fn payload(target: &Entity, source: &Entity) -> Result<Value> {
    let v = &source.data["last_values"];
    anyhow::ensure!(v.is_object(), "No current measurement");
    let seen = source.data["last_seen"]
        .as_i64()
        .context("Missing measurement time")?;
    anyhow::ensure!(
        chrono::Utc::now().timestamp_millis() - seen < 3600000,
        "Measurement is older than one hour"
    );
    let unit = v["temp_format"].as_str().unwrap_or("C");
    let temp = v
        .get("beer_temp")
        .or(v.get("gravity_temp"))
        .or(v.get("temp"))
        .cloned()
        .unwrap_or(Value::Null);
    let name = &source.name;
    Ok(match target.data["type"].as_str().unwrap_or("generic") {
        "brewfather" => {
            json!({"name":name,"report_source":"YeastCraft","temp":temp,"temp_unit":unit,"aux_temp":v["fridge_temp"],"ext_temp":v["room_temp"],"gravity":v["gravity"],"gravity_unit":"G"})
        }
        "brewersfriend" => {
            json!({"name":name,"report_source":"YeastCraft","device_source":source.data["sensor_type"],"temp":temp,"temp_unit":unit,"gravity":v["gravity"],"gravity_unit":"G","battery":v["battery"]})
        }
        "grainfather" => {
            json!({"name":format!("{},SG",target.name),"report_source":"YeastCraft","token":"grainfather","ID":0,"angle":0,"battery":v["battery"],"interval":900,"RSSI":v["rssi"],"gravity":v["gravity"],"temperature":temp,"temp_units":unit})
        }
        "thingspeak" => {
            json!({"api_key":target.data["api_key"],"field2":name,"field3":unit,"field4":temp,"field5":v["fridge_temp"],"field6":v["room_temp"],"field7":v["gravity"]})
        }
        "generic" => json!({"name":name,"time":seen,"values":v}),
        _ => anyhow::bail!("Unsupported export type"),
    })
}
pub async fn preview(
    State(a): State<App>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        a.db.run(move |c| {
            let target = db::get(c, &id)?;
            anyhow::ensure!(target.kind == "integrations", "Not an integration");
            let source = db::get(
                c,
                target.data["source"]
                    .as_str()
                    .or(target.data["device"].as_str())
                    .context("Select a source")?,
            )?;
            payload(&target, &source)
        })
        .await?,
    ))
}
pub async fn worker(a: App) {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("HTTP client");
    loop {
        let targets =
            a.db.run(|c| db::list(c, "integrations"))
                .await
                .unwrap_or_default();
        for target in targets {
            if target.data["enabled"] != true {
                continue;
            }
            let min = if target.data["type"] == "brewfather" {
                900000
            } else {
                60000
            };
            let interval = (target.data["interval"].as_i64().unwrap_or(15) * 60000).max(min);
            let now = chrono::Utc::now().timestamp_millis();
            if now - target.data["last_attempt"].as_i64().unwrap_or(0) < interval {
                continue;
            }
            let tid = target.id.clone();
            let for_payload = target.clone();
            let data =
                a.db.run(move |c| {
                    let s = db::get(
                        c,
                        for_payload.data["source"]
                            .as_str()
                            .or(for_payload.data["device"].as_str())
                            .context("No source")?,
                    )?;
                    payload(&for_payload, &s)
                })
                .await;
            let result = async {
                let data = data?;
                let url = target.data["url"].as_str().context("Missing URL")?;
                anyhow::ensure!(url.starts_with("https://"), "Exports require HTTPS");
                let mut req = client.post(url).json(&data);
                if target.data["type"] == "brewersfriend" {
                    req = req.header("X-API-KEY", target.data["api_key"].as_str().unwrap_or(""));
                }
                let status = req
                    .send()
                    .await
                    .map_err(|_| anyhow::anyhow!("Export connection failed"))?
                    .status();
                anyhow::ensure!(
                    status.is_success(),
                    "Export returned HTTP {}",
                    status.as_u16()
                );
                Ok::<_, anyhow::Error>(())
            }
            .await;
            let error = result.err().map(|e| e.to_string());
            let _ =
                a.db.run(move |c| {
                    let mut e = db::get(c, &tid)?;
                    e.data["last_attempt"] = json!(now);
                    if error.is_none() {
                        e.data["last_success"] = json!(now);
                    }
                    e.data["last_error"] = json!(error);
                    db::put(c, &e)
                })
                .await;
        }
        tokio::time::sleep(Duration::from_secs(15)).await;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn payload_preserves_zero_and_units() {
        let s = Entity {
            id: "d".into(),
            kind: "devices".into(),
            name: "Test".into(),
            data: json!({"last_seen":chrono::Utc::now().timestamp_millis(),"last_values":{"beer_temp":0,"temp_format":"C","gravity":1.01}}),
        };
        let t = Entity {
            id: "t".into(),
            kind: "integrations".into(),
            name: "Test".into(),
            data: json!({"type":"brewfather"}),
        };
        let v = payload(&t, &s).unwrap();
        assert_eq!(v["report_source"], "YeastCraft");
        assert_eq!(v["name"], "Test");
        assert_eq!(v["temp"], 0);
        assert_eq!(v["temp_unit"], "C");
        assert_eq!(v["gravity_unit"], "G");
    }
}

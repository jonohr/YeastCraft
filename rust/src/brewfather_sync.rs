// SPDX-License-Identifier: GPL-3.0-only
//! Only manual readings in the lifetime of an active, explicitly linked batch.
use crate::{App, db};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub async fn worker(a: App) {
    loop {
        let batches =
            a.db.run(|c| db::list(c, "batches"))
                .await
                .unwrap_or_default();
        for b in batches {
            let now = chrono::Utc::now().timestamp_millis();
            if b.data["status"] == "active"
                && b.data["brewfather"]["id"].is_string()
                && now
                    - b.data["brewfather_sync"]["last_attempt"]
                        .as_i64()
                        .unwrap_or(0)
                    >= 900_000
            {
                let _ = crate::brewfather::sync_readings(&a, &b.id).await;
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
    }
}

fn manual_rows(rows: &Value, start: i64, now: i64) -> Result<(BTreeMap<i64, Value>, bool)> {
    let rows = rows.as_array().context("Invalid readings response")?;
    let mut selected = BTreeMap::new();
    for row in rows {
        let time = row["time"].as_i64().context("Invalid measurement time")?;
        if row["type"] != "manual" || row["id"] != "manual" || time < start || time > now {
            continue;
        }
        // An explicitly cleared SG removes that point on a complete response.
        if row["sg"].is_null() {
            continue;
        }
        let sg = row["sg"]
            .as_f64()
            .filter(|g| (0.5..=2.0).contains(g))
            .context("Invalid manual SG")?;
        let value =
            json!({"gravity":sg,"reading_source":"manual","origin":"brewfather","temp_format":"C"});
        if let Some(previous) = selected.insert(time, value.clone()) {
            ensure!(
                previous == value,
                "Conflicting manual readings at the same time"
            );
        }
    }
    // Never infer deletion from a potentially truncated response.
    Ok((selected, rows.len() < 5000))
}

pub(crate) fn apply(
    c: &mut Connection,
    id: &str,
    remote: &str,
    rows: Option<&Value>,
    now: i64,
) -> Result<Value> {
    let tx = c.transaction()?;
    let mut b = db::get(&tx, id)?;
    ensure!(
        b.kind == "batches" && b.data["status"] == "active" && b.data["brewfather"]["id"] == remote,
        "Batch finished or connection changed during sync"
    );
    let start = chrono::DateTime::parse_from_rfc3339(
        b.data["created"].as_str().context("Missing batch start")?,
    )?
    .timestamp_millis();
    let parsed = rows
        .context("Brewfather unavailable")
        .and_then(|r| manual_rows(r, start, now));
    let mut status = b.data["brewfather_sync"].clone();
    if !status.is_object() {
        status = json!({});
    }
    status["last_attempt"] = json!(now);
    match parsed {
        Err(_) => {
            status["error"] = json!(
                "Could not sync manual readings. Check the Brewfather connection in Settings. Existing readings are retained."
            );
        }
        Ok((selected, complete)) => {
            // Identity is batch + original measurement timestamp, not poll time.
            let old = {
                let mut q = tx.prepare("SELECT time,sequence,values_json FROM points WHERE source=? AND json_extract(values_json,'$.origin')='brewfather'")?;
                q.query_map([id], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?
            };
            let mut added = 0;
            let mut updated = 0;
            let mut removed = 0;
            for (time, sequence, value) in &old {
                match selected.get(time) {
                    Some(new) if serde_json::from_str::<Value>(value)? != *new => {
                        tx.execute("UPDATE points SET values_json=? WHERE source=? AND time=? AND sequence=?", params![new.to_string(), id, time, sequence])?;
                        updated += 1;
                    }
                    None if complete => {
                        tx.execute(
                            "DELETE FROM points WHERE source=? AND time=? AND sequence=?",
                            params![id, time, sequence],
                        )?;
                        removed += 1;
                    }
                    _ => {}
                }
            }
            for (time, value) in &selected {
                if !old.iter().any(|(t, _, _)| t == time) {
                    db::append_point(&tx, id, *time, value)?;
                    added += 1;
                }
            }
            status["last_success"] = json!(now);
            status["error"] = Value::Null;
            status["warning"] = if complete {
                Value::Null
            } else {
                json!(
                    "Brewfather returned a limited readings window. Earlier readings are retained; deletions cannot be confirmed."
                )
            };
            status["latest"] = selected
                .last_key_value()
                .map(|(t, v)| json!({"time":t,"sg":v["gravity"]}))
                .unwrap_or(Value::Null);
            if added + updated + removed > 0 {
                tx.execute(
                    "INSERT INTO audit VALUES(?,?,?)",
                    params![
                        now / 1000,
                        "brewfather_manual_sync",
                        json!({"batch":id,"added":added,"updated":updated,"removed":removed})
                            .to_string()
                    ],
                )?;
            }
        }
    }
    b.data["brewfather_sync"] = status.clone();
    db::put(&tx, &b)?;
    tx.commit()?;
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, db::Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = db::Db::init(dir.path().join("sync.sqlite")).unwrap();
        let c = db.open().unwrap();
        db::put(&c, &db::Entity { id:"batch".into(), kind:"batches".into(), name:"Test".into(),
            data:json!({"status":"active","created":"1970-01-01T00:00:01Z","brewfather":{"id":"remote"},"device":"d","sensor":"s"}) }).unwrap();
        (dir, db)
    }
    fn rows(sg: f64) -> Value {
        json!([{"time":2000,"sg":sg,"id":"manual","type":"manual"}])
    }
    #[test]
    fn repeated_polls_restart_edits_and_deletions_preserve_local_measurements() {
        let (_dir, db) = setup();
        let mut c = db.open().unwrap();
        db::append_point(&c, "batch", 2000, &json!({"beer_temp":18})).unwrap();
        db::append_point(
            &c,
            "batch",
            2000,
            &json!({"gravity":1.06,"reading_source":"manual"}),
        )
        .unwrap();
        apply(&mut c, "batch", "remote", Some(&rows(1.033)), 3000).unwrap();
        drop(c);
        let mut c = db.open().unwrap();
        apply(&mut c, "batch", "remote", Some(&rows(1.033)), 4000).unwrap();
        assert_eq!(db::points(&c, "batch", 100).unwrap().len(), 3);
        apply(&mut c, "batch", "remote", Some(&rows(1.030)), 5000).unwrap();
        let ps = db::points(&c, "batch", 100).unwrap();
        assert_eq!(ps.last().unwrap().values["gravity"], 1.030);
        assert_eq!(ps.last().unwrap().time, 2000);
        apply(&mut c, "batch", "remote", Some(&json!([])), 6000).unwrap();
        assert_eq!(db::points(&c, "batch", 100).unwrap().len(), 2);
        assert_eq!(
            c.query_row("SELECT count(*) FROM audit", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
    }
    #[test]
    fn only_manual_after_start_no_future_automatic_or_wrong_batch() {
        let (_dir, db) = setup();
        let mut c = db.open().unwrap();
        let input = json!([
            {"time":999,"sg":1.05,"id":"manual","type":"manual"},
            {"time":2000,"sg":1.033,"id":"manual","type":"manual"},
            {"time":2001,"sg":1.02,"id":"device","type":"iSpindel"},
            {"time":2002,"sg":1.01,"id":"device","type":"manual"},
            {"time":9000,"sg":1.01,"id":"manual","type":"manual"}
        ]);
        apply(&mut c, "batch", "remote", Some(&input), 3000).unwrap();
        assert_eq!(db::points(&c, "batch", 100).unwrap().len(), 1);
        assert!(db::points(&c, "s", 100).unwrap().is_empty());
        assert!(apply(&mut c, "batch", "wrong", Some(&rows(1.02)), 4000).is_err());
        let mut b = db::get(&c, "batch").unwrap();
        b.data["status"] = json!("completed");
        db::put(&c, &b).unwrap();
        assert!(apply(&mut c, "batch", "remote", Some(&rows(1.02)), 5000).is_err());
    }
    #[test]
    fn errors_and_truncated_windows_do_not_erase_readings() {
        let (_dir, db) = setup();
        let mut c = db.open().unwrap();
        apply(&mut c, "batch", "remote", Some(&rows(1.033)), 3000).unwrap();
        for input in [
            None,
            Some(json!({})),
            Some(rows(33.0)),
            Some(json!([{"sg":1.03}])),
        ] {
            let s = apply(&mut c, "batch", "remote", input.as_ref(), 4000).unwrap();
            assert!(s["error"].is_string());
            assert_eq!(s["last_success"], 3000);
            assert_eq!(db::points(&c, "batch", 100).unwrap().len(), 1);
        }
        let many = Value::Array(vec![
            json!({"time":2001,"sg":1.02,"id":"dev","type":"iSpindel"});
            5000
        ]);
        let s = apply(&mut c, "batch", "remote", Some(&many), 5000).unwrap();
        assert!(s["warning"].is_string());
        assert_eq!(db::points(&c, "batch", 100).unwrap().len(), 1);
    }
    #[test]
    fn manual_point_survives_dense_chart_sampling() {
        let (_dir, db) = setup();
        let mut c = db.open().unwrap();
        for t in 1000..11000 {
            db::append_point(&c, "batch", t, &json!({"beer_temp":18})).unwrap();
        }
        apply(&mut c, "batch", "remote", Some(&rows(1.033)), 12000).unwrap();
        let ps = db::points(&c, "batch", 20).unwrap();
        assert!(ps.len() < 25);
        assert!(
            ps.iter()
                .any(|p| p.values["origin"] == "brewfather" && p.values["gravity"] == 1.033)
        );
    }
    #[test]
    fn imported_manual_drives_only_its_active_batch_profile() {
        let (_dir, db) = setup();
        let mut c = db.open().unwrap();
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
        let p = json!({"unit":"C","gravity_sensor":"s","gravity_readings":"manual","steps":[
            {"temperature":18,"hours":24,"transition":"hold","until":{"kind":"sg","sg":1.04}},
            {"temperature":20,"hours":24,"transition":"hold"}]});
        let mut d = db::Entity {
            id: "other-device".into(),
            kind: "devices".into(),
            name: "Test".into(),
            data: json!({"profile_run":crate::gravity_profile::initial(&p,1000)}),
        };
        d.data["profile_run"]["applied"] = json!(true);
        apply(&mut c, "batch", "remote", Some(&rows(1.033)), 3000).unwrap();
        assert_eq!(
            crate::gravity_profile::tick(&c, &mut d, 4000, "C")
                .unwrap()
                .0,
            18.
        );
        d.id = "d".into();
        assert_eq!(
            crate::gravity_profile::tick(&c, &mut d, 4000, "C")
                .unwrap()
                .0,
            20.
        );
        assert_eq!(
            d.data["profile_run"]["last_transition"]["evidence"]["reading_source"],
            "manual"
        );
        assert_eq!(
            crate::gravity_profile::tick(&c, &mut d, 5000, "C")
                .unwrap()
                .0,
            20.
        );
    }
}

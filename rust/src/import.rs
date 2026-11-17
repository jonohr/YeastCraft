// SPDX-License-Identifier: GPL-3.0-only
use crate::db::{self, Db, Entity, Point};
use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OpenFlags, params, types::ValueRef};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};
pub struct Plan {
    pub entities: Vec<Entity>,
    pub points: usize,
    pub warnings: Vec<String>,
    pub digest: String,
    pub files: usize,
    pub spool: tempfile::NamedTempFile,
}
pub fn timestamp(s: &str) -> Result<i64> {
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
        return Ok(t.timestamp_millis());
    }
    Ok(
        chrono::NaiveDateTime::parse_from_str(s, "%Y/%m/%d %H:%M:%SZ")
            .context("Unrecognized timestamp; expected UTC Z or RFC3339")?
            .and_utc()
            .timestamp_millis(),
    )
}
fn rows(c: &Connection, t: &str) -> Result<Vec<Value>> {
    let mut s = c.prepare(&format!("SELECT * FROM \"{t}\""))?;
    let names = s
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let mut rs = s.query([])?;
    let mut out = Vec::new();
    while let Some(r) = rs.next()? {
        let mut obj = serde_json::Map::new();
        for (i, n) in names.iter().enumerate() {
            let v = match r.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(x) => json!(x),
                ValueRef::Real(x) => json!(x),
                ValueRef::Text(x) => json!(std::str::from_utf8(x)?),
                ValueRef::Blob(_) => bail!("Unsupported binary field in {t}.{n}"),
            };
            obj.insert(n.clone(), v);
        }
        out.push(Value::Object(obj));
    }
    Ok(out)
}
pub fn workdir(db: &Db) -> std::path::PathBuf {
    std::env::var_os("FERMENTRACK_WORK_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| db.0.parent().unwrap_or(Path::new(".")).join("import-work"))
}
pub fn plan_in(source: &Path, data: &Path, work: &Path) -> Result<Plan> {
    anyhow::ensure!(
        source.is_file() && data.is_dir(),
        "Choose an existing database copy and data directory"
    );
    let c = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let ok: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    anyhow::ensure!(ok == "ok", "Source SQLite integrity check failed");
    let tables = c
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mapping = [
        ("external_push_genericpushtarget", "integrations"),
        ("external_push_brewfatherpushtarget", "integrations"),
        ("external_push_brewersfriendpushtarget", "integrations"),
        ("external_push_grainfatherpushtarget", "integrations"),
        ("external_push_thingspeakpushtarget", "integrations"),
        ("app_brewpidevice", "devices"),
        ("app_beer", "batches"),
        ("app_fermentationprofile", "profiles"),
        ("gravity_gravitysensor", "sensors"),
        ("gravity_gravitylog", "gravity_logs"),
        ("gravity_tiltconfiguration", "calibrations"),
        ("gravity_ispindelconfiguration", "calibrations"),
        ("gravity_tilttempcalibrationpoint", "calibrations"),
        ("gravity_tiltgravitycalibrationpoint", "calibrations"),
        ("gravity_ispindelgravitycalibrationpoint", "calibrations"),
    ];
    anyhow::ensure!(
        tables.iter().any(|t| t == "app_brewpidevice"),
        "Not a recognized Fermentrack database"
    );
    std::fs::create_dir_all(work)?;
    let spool = tempfile::NamedTempFile::new_in(work)?;
    let stage = Connection::open(spool.path())?;
    stage.execute_batch("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; CREATE TABLE points(source TEXT,time INTEGER,sequence INTEGER,values_json TEXT,PRIMARY KEY(source,time,sequence)); BEGIN;")?;
    let mut p = Plan {
        entities: vec![],
        points: 0,
        warnings: vec![],
        digest: String::new(),
        files: 0,
        spool,
    };
    let mut units = BTreeMap::new();
    let mut profiles = BTreeMap::new();
    for (t, kind) in mapping {
        if !tables.iter().any(|s| s == t) {
            continue;
        }
        for mut row in rows(&c, t)? {
            let legacy = row["id"]
                .as_i64()
                .or(row["sensor_id"].as_i64())
                .with_context(|| format!("Invalid legacy ID in {t}"))?;
            let name = row["name"]
                .as_str()
                .or(row["device_name"].as_str())
                .map(String::from)
                .unwrap_or_else(|| format!("{t} #{legacy}"));
            let id = format!("legacy:{t}:{legacy}");
            row["legacy_table"] = json!(t);
            row["legacy_id"] = json!(legacy);
            if kind == "integrations" {
                let target_type = if t.contains("brewfather") {
                    "brewfather"
                } else if t.contains("brewersfriend") {
                    "brewersfriend"
                } else if t.contains("grainfather") {
                    "grainfather"
                } else if t.contains("thingspeak") {
                    "thingspeak"
                } else {
                    "generic"
                };
                row["type"] = json!(target_type);
                row["enabled"] = json!(false);
                row["url"] = row
                    .get("logging_url")
                    .or(row.get("target_host"))
                    .cloned()
                    .unwrap_or(Value::Null);
                row["interval"] =
                    json!((row["push_frequency"].as_i64().unwrap_or(900) / 60).max(1));
                if let Some(sid) = row["gravity_sensor_to_push_id"].as_i64() {
                    row["source"] = json!(format!("legacy:gravity_gravitysensor:{sid}"));
                } else if let Some(did) = row["brewpi_to_push_id"].as_i64() {
                    row["source"] = json!(format!("legacy:app_brewpidevice:{did}"));
                }
            }
            if kind == "devices" {
                row["collection_enabled"] = json!(false);
                row["control_claimed"] = json!(false);
                row["host"] = row["wifi_host"].clone();
                row["port"] = row["wifi_port"].clone();
                row["unit"] = row["temp_format"].clone();
            }
            if kind == "batches" || kind == "gravity_logs" {
                units.insert(
                    (if kind == "batches" { "beer" } else { "gravity" }, legacy),
                    (
                        id.clone(),
                        row["format"].as_str().unwrap_or("C").to_string(),
                    ),
                );
                let table = if kind == "batches" {
                    "app_brewpidevice"
                } else {
                    "gravity_gravitysensor"
                };
                if let Some(dev) = row["device_id"].as_i64() {
                    row["device"] = json!(format!("legacy:{table}:{dev}"));
                }
            }
            if kind == "calibrations"
                && let Some(sid) = row["sensor_id"].as_i64()
            {
                row["sensor"] = json!(format!("legacy:gravity_gravitysensor:{sid}"));
            }
            if kind == "sensors" {
                row["collection_enabled"] = json!(false);
                if let Some(dev) = row["assigned_brewpi_device_id"].as_i64() {
                    row["device"] = json!(format!("legacy:app_brewpidevice:{dev}"));
                }
            }
            if kind == "profiles" {
                profiles.insert(legacy, p.entities.len());
                row["steps"] = json!([]);
            }
            p.entities.push(Entity {
                id,
                kind: kind.into(),
                name,
                data: row,
            });
        }
    }
    if tables.iter().any(|t| t == "app_fermentationprofilepoint") {
        for r in rows(&c, "app_fermentationprofilepoint")? {
            if let Some(i) = r["profile_id"].as_i64().and_then(|id| profiles.get(&id)) {
                let data = &mut p.entities[*i].data;
                if data.get("legacy_steps").is_none() {
                    data["legacy_steps"] = json!([]);
                }
                data["legacy_steps"].as_array_mut().unwrap().push(r);
            }
        }
    }
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&p.entities)?);
    let mut ordinals = BTreeMap::<String, i64>::new();
    let mut entries = std::fs::read_dir(data)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|e| e.file_name());
    for ent in entries {
        let path = ent.path();
        if !ent.file_type()?.is_file() {
            continue;
        }
        let filename = ent.file_name().to_string_lossy().to_string();
        if filename.ends_with("_graph.csv")
            && path
                .with_file_name(filename.replace("_graph.csv", "_full.csv"))
                .exists()
        {
            continue;
        }
        if !(filename.ends_with("_full.csv") || filename.ends_with("_graph.csv")) {
            if filename.ends_with(".almost_json") {
                p.warnings.push(format!("Separate annotation file retained in source only: {filename}; annotations in full CSV are imported"));
            }
            continue;
        }
        let gravity = filename.starts_with("Gravity Device ");
        let marker = if gravity { " - L" } else { " - B" };
        let Some(id) = filename
            .split(marker)
            .nth(1)
            .and_then(|x| x.split(" - ").next())
            .and_then(|x| x.parse::<i64>().ok())
        else {
            p.warnings
                .push(format!("Unrecognized CSV filename: {filename}"));
            continue;
        };
        let Some((source, unit)) = units.get(&(if gravity { "gravity" } else { "beer" }, id))
        else {
            p.warnings.push(format!("No metadata for {filename}"));
            continue;
        };
        let bytes = std::fs::read(&path)?;
        hasher.update(filename.as_bytes());
        hasher.update(&bytes);
        let mut reader = csv::Reader::from_reader(bytes.as_slice());
        let heads = reader.headers()?.clone();
        anyhow::ensure!(
            heads.iter().any(|s| s == "log_time"),
            "Missing log_time in {filename}"
        );
        for (line, record) in reader.records().enumerate() {
            let record = record.with_context(|| format!("{filename} row {}", line + 2))?;
            let mut values = serde_json::Map::new();
            let mut time = None;
            for (k, v) in heads.iter().zip(record.iter()) {
                if k == "log_time" {
                    time =
                        Some(timestamp(v).with_context(|| format!("{filename} row {}", line + 2))?);
                    continue;
                }
                if v.is_empty() || v == "None" || v == "null" {
                    values.insert(k.into(), Value::Null);
                } else if v == "True" || v == "False" {
                    values.insert(k.into(), json!(v == "True"));
                } else if matches!(
                    k,
                    "beer_ann"
                        | "fridge_ann"
                        | "extra_data"
                        | "temp_format"
                        | "log_id"
                        | "associated_beer_id"
                ) {
                    values.insert(k.into(), json!(v));
                } else {
                    let n: f64 = v.parse().with_context(|| {
                        format!("Invalid numeric {k} in {filename} row {}", line + 2)
                    })?;
                    anyhow::ensure!(n.is_finite(), "Non-finite measurement");
                    values.insert(k.into(), json!(n));
                }
            }
            for (field, series) in [("beer_ann", "beer_temp"), ("fridge_ann", "fridge_temp")] {
                if let Some(text) = values
                    .get(field)
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    let time = time.context("Missing time")?;
                    let key = format!("{source}:{time}:{series}:{text}");
                    let id = format!("annotation:{:x}", Sha256::digest(key.as_bytes()));
                    if !p.entities.iter().any(|e| e.id == id) {
                        p.entities.push(Entity{id,kind:"notes".into(),name:text.chars().take(120).collect(),data:json!({"batch":source,"text":text,"created":chrono::DateTime::from_timestamp_millis(time).unwrap().to_rfc3339(),"series":series})});
                    }
                }
            }
            values.entry("temp_format").or_insert(json!(unit));
            let sequence = ordinals.entry(source.clone()).or_insert(0);
            let pt = Point {
                source: source.clone(),
                time: time.context("Missing time")?,
                sequence: *sequence,
                values: Value::Object(values),
            };
            *sequence += 1;
            db::point(&stage, &pt)?;
            p.points += 1;
        }
        p.files += 1;
    }
    // Sequence preserves distinct original rows sharing a timestamp.
    stage.execute_batch("COMMIT;")?;
    for (source, _) in units.values() {
        if !ordinals.contains_key(source) {
            p.warnings.push(format!(
                "No history file found for {source}; metadata is preserved"
            ));
        }
    }
    for e in &p.entities {
        db::validate(e)?;
    }
    p.digest = format!("{:x}", hasher.finalize());
    Ok(p)
}
pub fn report(p: &Plan) -> Value {
    let mut kinds = BTreeMap::new();
    for e in &p.entities {
        *kinds.entry(&e.kind).or_insert(0) += 1;
    }
    json!({"digest":p.digest,"entities":p.entities.len(),"by_kind":kinds,"points":p.points,"files":p.files,"warnings":p.warnings})
}
pub fn apply(c: &mut Connection, p: Plan) -> Result<Value> {
    let mut summary = report(&p);
    let tx = c.transaction()?;
    let done: i64 = tx.query_row(
        "SELECT COUNT(*) FROM imports WHERE digest=?",
        [&p.digest],
        |r| r.get(0),
    )?;
    if done > 0 {
        summary["already_imported"] = json!(true);
        return Ok(summary);
    }
    // Refuse overwriting existing imported records with changed source data.
    for e in &p.entities {
        let n: i64 = tx.query_row("SELECT COUNT(*) FROM entities WHERE id=?", [&e.id], |r| {
            r.get(0)
        })?;
        anyhow::ensure!(
            n == 0,
            "Destination already contains {}; use an empty destination or restore a matching snapshot",
            e.id
        );
        db::put(&tx, e)?;
    }
    let stage = Connection::open(p.spool.path())?;
    let mut st = stage.prepare(
        "SELECT source,time,sequence,values_json FROM points ORDER BY source,time,sequence",
    )?;
    let mut cursor = st.query([])?;
    let mut written = 0;
    while let Some(row) = cursor.next()? {
        let pt = Point {
            source: row.get(0)?,
            time: row.get(1)?,
            sequence: row.get(2)?,
            values: serde_json::from_str(&row.get::<_, String>(3)?)?,
        };
        written += usize::from(db::point(&tx, &pt)?);
    }
    summary["written_points"] = json!(written);
    tx.execute(
        "INSERT INTO imports VALUES(?,?,?)",
        params![
            p.digest,
            summary.to_string(),
            chrono::Utc::now().timestamp()
        ],
    )?;
    tx.commit()?;
    Ok(summary)
}
pub async fn cli(db: &Db, source: &Path, data: &Path, commit: bool) -> Result<Value> {
    let p = plan_in(source, data, &workdir(db))?;
    if commit {
        db.run(move |c| apply(c, p)).await
    } else {
        Ok(report(&p))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timestamps() {
        assert_eq!(
            timestamp("2026/11/12 10:00:00Z").unwrap(),
            timestamp("2026-11-12T11:00:00+01:00").unwrap()
        );
        assert!(timestamp("2026-11-12 11:00").is_err());
    }
    #[tokio::test]
    async fn replay_and_fail_atomic() {
        let t = tempfile::tempdir().unwrap();
        let s = t.path().join("source.sqlite");
        let c = Connection::open(&s).unwrap();
        c.execute_batch("CREATE TABLE app_brewpidevice(id INTEGER,device_name TEXT,temp_format TEXT);INSERT INTO app_brewpidevice VALUES(1,'Chamber','C');CREATE TABLE app_beer(id INTEGER,name TEXT,device_id INTEGER,format TEXT);INSERT INTO app_beer VALUES(1,'Test',1,'C');").unwrap();
        let data = t.path().join("data");
        std::fs::create_dir(&data).unwrap();
        std::fs::write(
            data.join("Device 1 - B1 - Test_full.csv"),
            "log_time,beer_temp,beer_set,temp_format\n2026/11/12 10:00:00Z,0,18,C\n2026/11/12 10:00:00Z,1,18,C\n",
        )
        .unwrap();
        let db = Db::init(t.path().join("dest.sqlite")).unwrap();
        let p = plan_in(&s, &data, &t.path().join("work")).unwrap();
        assert_eq!(
            db::points(
                &Connection::open(p.spool.path()).unwrap(),
                "legacy:app_beer:1",
                10
            )
            .unwrap()[0]
                .values["beer_temp"],
            0.0
        );
        assert_eq!(p.entities[0].data["collection_enabled"], false);
        let r = db.run(move |c| apply(c, p)).await.unwrap();
        assert_eq!(r["written_points"], 2);
        let p = plan_in(&s, &data, &t.path().join("work")).unwrap();
        assert_eq!(
            db.run(move |c| apply(c, p)).await.unwrap()["already_imported"],
            true
        );
        std::fs::write(
            data.join("Device 1 - B1 - Test_full.csv"),
            "log_time,beer_temp\ninvalid,broken\n",
        )
        .unwrap();
        assert!(plan_in(&s, &data, &t.path().join("work")).is_err());
        assert_eq!(
            db.run(|c| Ok(db::points(c, "legacy:app_beer:1", 10)?.len()))
                .await
                .unwrap(),
            2
        );
    }
}

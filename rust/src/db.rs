// SPDX-License-Identifier: GPL-3.0-only
use anyhow::{Result, bail};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc, time::Duration};
#[derive(Clone)]
pub struct Db(pub Arc<PathBuf>);
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entity {
    pub id: String,
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub data: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Point {
    pub source: String,
    pub time: i64,
    #[serde(default)]
    pub sequence: i64,
    pub values: Value,
}
pub const KINDS: &[&str] = &[
    "devices",
    "sensors",
    "batches",
    "profiles",
    "notes",
    "integrations",
    "settings",
    "calibrations",
    "gravity_logs",
];
impl Db {
    pub fn open(&self) -> Result<Connection> {
        let c = Connection::open(self.0.as_ref())?;
        c.busy_timeout(Duration::from_secs(5))?;
        c.execute_batch("PRAGMA foreign_keys=ON;")?;
        Ok(c)
    }
    pub fn init(path: PathBuf) -> Result<Self> {
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p)?;
        }
        let db = Self(Arc::new(path));
        let c = db.open()?;
        c.execute_batch("PRAGMA journal_mode=WAL;
   CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS entities_kind ON entities(kind);
   CREATE TABLE IF NOT EXISTS points(source TEXT NOT NULL,time INTEGER NOT NULL,sequence INTEGER NOT NULL DEFAULT 0,values_json TEXT NOT NULL, PRIMARY KEY(source,time,sequence));
   CREATE TABLE IF NOT EXISTS users(name TEXT PRIMARY KEY,hash TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,name TEXT NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS imports(digest TEXT PRIMARY KEY,report TEXT NOT NULL,created INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS audit(time INTEGER NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL);")?;
        let has_sequence = c
            .prepare("PRAGMA table_info(points)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .iter()
            .any(|x| x == "sequence");
        if !has_sequence {
            c.execute_batch("BEGIN; ALTER TABLE points RENAME TO old_points; CREATE TABLE points(source TEXT NOT NULL,time INTEGER NOT NULL,sequence INTEGER NOT NULL DEFAULT 0,values_json TEXT NOT NULL,PRIMARY KEY(source,time,sequence)); INSERT INTO points SELECT source,time,0,values_json FROM old_points; DROP TABLE old_points; COMMIT;")?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(db.0.as_ref(), std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(db)
    }
    pub async fn run<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let db = self.clone();
        tokio::task::spawn_blocking(move || f(&mut db.open()?)).await?
    }
}
pub fn list(c: &Connection, kind: &str) -> Result<Vec<Entity>> {
    if !KINDS.contains(&kind) {
        bail!("Unknown resource");
    }
    let mut s =
        c.prepare("SELECT id,kind,name,data FROM entities WHERE kind=? ORDER BY name,id")?;
    let rows = s.query_map([kind], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    rows.map(|r| {
        let (id, kind, name, data) = r?;
        Ok(Entity {
            id,
            kind,
            name,
            data: serde_json::from_str(&data)?,
        })
    })
    .collect()
}
pub fn get(c: &Connection, id: &str) -> Result<Entity> {
    let (id, kind, name, data) = c.query_row(
        "SELECT id,kind,name,data FROM entities WHERE id=?",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, String>(3)?)),
    )?;
    Ok(Entity {
        id,
        kind,
        name,
        data: serde_json::from_str(&data)?,
    })
}
pub fn validate(e: &Entity) -> Result<()> {
    if e.kind == "sensors" && e.data["sensor_type"] == "ispindel" {
        let source = e.data["gravity_source"].as_str().unwrap_or("server");
        anyhow::ensure!(
            ["server", "device"].contains(&source),
            "Unknown gravity source"
        );
        let unit = e.data["reported_gravity_unit"]
            .as_str()
            .unwrap_or("unknown");
        anyhow::ensure!(
            ["SG", "Plato", "unknown"].contains(&unit),
            "Unknown device gravity unit"
        );
        anyhow::ensure!(
            source != "device" || unit != "unknown",
            "Choose SG or Plato before using device gravity"
        );
    }
    if !KINDS.contains(&e.kind.as_str())
        || e.id.is_empty()
        || e.id.len() > 200
        || e.name.trim().is_empty()
        || e.name.chars().count() > 255
        || !e.data.is_object()
    {
        bail!("Invalid resource, name or data");
    }
    if e.kind == "profiles" {
        crate::gravity_profile::validate(&e.data)?;
    }
    if e.kind == "profiles"
        && let Some(steps) = e.data.get("steps")
    {
        let steps = steps
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("steps must be an array"))?;
        for p in steps {
            let t = p["temperature"]
                .as_f64()
                .ok_or_else(|| anyhow::anyhow!("Invalid temperature"))?;
            let h = p["hours"]
                .as_f64()
                .ok_or_else(|| anyhow::anyhow!("Invalid duration"))?;
            if !(-50.0..=100.0).contains(&t) || h <= 0.0 || h > 87600.0 {
                bail!("Invalid profile step");
            }
        }
    }
    Ok(())
}
pub fn put(c: &Connection, e: &Entity) -> Result<()> {
    validate(e)?;
    c.execute("INSERT INTO entities VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data WHERE entities.kind=excluded.kind",params![e.id,e.kind,e.name,e.data.to_string()])?;
    Ok(())
}
pub fn point(c: &Connection, p: &Point) -> Result<bool> {
    if p.source.is_empty() || !p.values.is_object() {
        bail!("Invalid measurement");
    }
    Ok(c.execute(
        "INSERT OR IGNORE INTO points VALUES(?,?,?,?)",
        params![p.source, p.time, p.sequence, p.values.to_string()],
    )? > 0)
}
pub fn append_point(c: &Connection, source: &str, time: i64, values: &Value) -> Result<()> {
    anyhow::ensure!(
        !source.is_empty() && values.is_object(),
        "Invalid measurement"
    );
    c.execute("INSERT INTO points SELECT ?1,?2,COALESCE(MAX(sequence),-1)+1,?3 FROM points WHERE source=?1 AND time=?2", params![source,time,values.to_string()])?;
    Ok(())
}
pub fn points(c: &Connection, source: &str, limit: usize) -> Result<Vec<Point>> {
    let count: i64 = c.query_row(
        "SELECT COUNT(*) FROM points WHERE source=?",
        [source],
        |r| r.get(0),
    )?;
    let stride = (count as usize)
        .div_ceil(limit.saturating_sub(1).max(1))
        .max(1);
    let mut s=c.prepare("SELECT time,sequence,values_json FROM (SELECT time,sequence,values_json,ROW_NUMBER() OVER(ORDER BY time,sequence) AS n FROM points WHERE source=?) WHERE (n-1)%?=0 OR n=? ORDER BY time,sequence LIMIT ?")?;
    let rows = s.query_map(
        params![source, stride as i64, count, limit as i64 + 1],
        |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, String>(2)?)),
    )?;
    rows.map(|r| {
        let (time, sequence, v) = r?;
        Ok(Point {
            source: source.into(),
            time,
            sequence,
            values: serde_json::from_str(&v)?,
        })
    })
    .collect()
}
pub fn snapshot(c: &Connection) -> Result<Value> {
    let entities = KINDS
        .iter()
        .map(|k| list(c, k))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let mut s = c.prepare(
        "SELECT source,time,sequence,values_json FROM points ORDER BY source,time,sequence",
    )?;
    let ps = s
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .map(|r| {
            let (source, time, sequence, v) = r?;
            Ok(Point {
                source,
                time,
                sequence,
                values: serde_json::from_str(&v)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(
        json!({"version":1,"entities":entities,"points":ps,"created":chrono::Utc::now().to_rfc3339()}),
    )
}
pub fn restore(c: &mut Connection, v: Value) -> Result<Value> {
    if v["version"] != 1 {
        bail!("Unsupported backup version");
    }
    let es: Vec<Entity> = serde_json::from_value(v["entities"].clone())?;
    let ps: Vec<Point> = serde_json::from_value(v["points"].clone())?;
    for e in &es {
        validate(e)?;
    }
    let tx = c.transaction()?;
    tx.execute("DELETE FROM points", [])?;
    tx.execute("DELETE FROM entities", [])?;
    tx.execute("DELETE FROM imports", [])?;
    for mut e in es.clone() {
        if e.kind == "devices" || e.kind == "sensors" {
            e.data["collection_enabled"] = json!(false);
            e.data["control_claimed"] = json!(false);
        }
        if e.kind == "integrations" {
            e.data["enabled"] = json!(false);
        }
        put(&tx, &e)?;
    }
    for p in &ps {
        point(&tx, p)?;
    }
    tx.commit()?;
    Ok(json!({"entities":es.len(),"points":ps.len(),"collection_enabled":false}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restore_atomic_and_no_reactivation() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT,name TEXT,data TEXT);CREATE TABLE points(source TEXT,time INTEGER,sequence INTEGER,values_json TEXT,PRIMARY KEY(source,time,sequence));CREATE TABLE imports(digest TEXT);").unwrap();
        let e = Entity {
            id: "d".into(),
            kind: "devices".into(),
            name: "Device".into(),
            data: json!({"collection_enabled":true,"control_claimed":true}),
        };
        put(&c, &e).unwrap();
        let backup = snapshot(&c).unwrap();
        restore(&mut c, backup).unwrap();
        assert_eq!(get(&c, "d").unwrap().data["collection_enabled"], false);
        assert!(restore(&mut c, json!({"version":2})).is_err());
        assert_eq!(list(&c, "devices").unwrap().len(), 1);
    }
}

// SPDX-License-Identifier: GPL-3.0-only
use super::*;
use axum::http::StatusCode;

fn configuration(row: &Value) -> Value {
    let mut result = serde_json::Map::new();
    for key in ["i", "c", "b", "f", "h", "p", "x", "j", "a", "n", "d", "t"] {
        if let Some(value) = row.get(key) {
            result.insert(key.into(), value.clone());
        }
    }
    Value::Object(result)
}
fn revision(rows: &[Value]) -> String {
    let mut rows = rows
        .iter()
        .map(configuration)
        .map(|v| v.to_string())
        .collect::<Vec<_>>();
    rows.sort();
    crate::auth::digest(&rows.join("\n"))
}
async fn device(a: &App, id: &str) -> Result<db::Entity> {
    anyhow::ensure!(a.collection, "Server collection must be enabled");
    let id = id.to_string();
    let d = a.db.run(move |c| db::get(c, &id)).await?;
    anyhow::ensure!(
        d.kind == "devices"
            && d.data["collection_enabled"] == true
            && d.data["control_claimed"] == true,
        "Confirmed ownership and enabled collection are required to read controller pins"
    );
    Ok(d)
}
async fn array(d: &db::Entity, command: &str, prefix: &str) -> Result<Vec<Value>> {
    let reply = exchange_device(d, command, prefix).await?;
    let values: Vec<Value> = serde_json::from_str(reply.trim_start_matches(prefix))?;
    anyhow::ensure!(
        values.len() <= 128 && values.iter().all(Value::is_object),
        "Invalid device inventory from the controller"
    );
    Ok(values)
}
async fn snapshot(d: &db::Entity) -> Result<Value> {
    ensure_units(d).await?;
    let version = exchange_device(d, "n\n", "N:").await?;
    let version: Value = serde_json::from_str(version.trim_start_matches("N:"))?;
    let installed = array(d, "d{r:1}\n", "d:").await?;
    let available = array(d, "h{u:-1,v:1}\n", "h:").await?;
    Ok(
        json!({"version":version,"revision":revision(&installed),"installed":installed,"available":available}),
    )
}
pub async fn read(State(a): State<App>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let op = operation(&id);
    let _guard = op.lock().await;
    Ok(Json(snapshot(&device(&a, &id).await?).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    expected_revision: String,
    index: i64,
    hardware: i64,
    pin: i64,
    #[serde(default)]
    address: String,
    function: i64,
    #[serde(default)]
    inverted: bool,
    calibration: Option<f64>,
    confirm_ownership: bool,
}
fn same_device(row: &Value, change: &Change) -> bool {
    row["h"].as_i64() == Some(change.hardware)
        && row["p"].as_i64() == Some(change.pin)
        && (change.hardware != 2 || row["a"].as_str() == Some(change.address.as_str()))
}
fn numeric(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
}
fn matches(row: &Value, wanted: &Value) -> bool {
    ["i", "c", "b", "f", "h", "p", "a", "n", "x", "j"]
        .iter()
        .all(|&key| {
            let Some(wanted) = wanted.get(key) else {
                return true;
            };
            match key {
                "j" => numeric(&row[key])
                    .zip(numeric(wanted))
                    .is_some_and(|(a, b)| (a - b).abs() <= 0.02),
                "x" => {
                    row[key]
                        .as_bool()
                        .map(|v| v as i64)
                        .or_else(|| row[key].as_i64())
                        == wanted.as_i64()
                }
                _ => row[key] == *wanted,
            }
        })
}
fn prepare(change: &Change, current: &Value, installed: &[Value]) -> Result<Value> {
    anyhow::ensure!(change.index >= -1, "Ogiltigt enhetsindex");
    anyhow::ensure!(
        [1, 2].contains(&change.hardware),
        "Editing currently supports digital pins and OneWire temperature probes"
    );
    let allowed = if change.hardware == 1 {
        vec![0, 1, 2, 3, 4, 7]
    } else {
        vec![0, 5, 6, 9]
    };
    anyhow::ensure!(
        allowed.contains(&change.function),
        "This hardware type does not support the selected function"
    );
    if change.function > 0 {
        anyhow::ensure!(
            !installed
                .iter()
                .any(|r| r["f"].as_i64() == Some(change.function)
                    && r["i"].as_i64() != Some(change.index)),
            "This function is already assigned; remove its existing assignment first"
        );
    }
    let index = if change.index >= 0 {
        change.index
    } else {
        anyhow::ensure!(
            change.function != 0,
            "En otilldelad enhet kan inte avinstalleras"
        );
        (0..25)
            .find(|i| !installed.iter().any(|r| r["i"].as_i64() == Some(*i)))
            .ok_or_else(|| anyhow::anyhow!("Inga lediga konfigurationsplatser"))?
    };
    anyhow::ensure!((0..128).contains(&index), "Ogiltigt enhetsindex");
    let mut wanted = json!({"i":index,"c":if change.function == 0 {0} else {1},"b":if change.function==9 {1} else {0},"f":change.function,"h":change.hardware,"p":change.pin});
    if change.hardware == 1 {
        wanted["x"] = json!(change.inverted as u8);
    } else {
        let calibration = change
            .calibration
            .or_else(|| numeric(&current["j"]))
            .unwrap_or(0.0);
        anyhow::ensure!(
            calibration.is_finite() && calibration.abs() <= 10.0,
            "Calibration offset must be between -10 and 10 degrees"
        );
        anyhow::ensure!(
            change.address.len() == 16 && change.address.bytes().all(|b| b.is_ascii_hexdigit()),
            "Ogiltig OneWire-adress"
        );
        wanted["a"] = json!(change.address);
        wanted["j"] = json!(calibration);
    }
    Ok(wanted)
}
async fn audit(a: &App, action: &str, detail: Value) -> Result<()> {
    let action = action.to_string();
    a.db.run(move |c| {
        c.execute(
            "INSERT INTO audit VALUES(?,?,?)",
            rusqlite::params![chrono::Utc::now().timestamp(), action, detail.to_string()],
        )?;
        Ok(())
    })
    .await
}
fn wire_command(wanted: &Value) -> String {
    // Match the original writer's order, including slot before its attributes.
    let fields = ["i", "c", "b", "f", "h", "p", "x", "j", "a", "n"]
        .iter()
        .filter_map(|key| wanted.get(*key).map(|v| format!("\"{key}\":{v}")))
        .collect::<Vec<_>>();
    format!("U{{{}}}\n", fields.join(","))
}
pub async fn write(
    State(a): State<App>,
    Path(id): Path<String>,
    Json(change): Json<Change>,
) -> Result<Json<Value>, ApiError> {
    if !a.control || !change.confirm_ownership {
        return Err(ApiError::bad(
            "Enabled control and confirmed sole ownership are required",
        ));
    }
    let op = operation(&id);
    let _guard = op.lock().await;
    let d = device(&a, &id).await?;
    if d.data["profile"].is_string() {
        return Err(ApiError::bad(
            "Stop the running profile before changing pins",
        ));
    }
    let settings = exchange_device(&d, "s\n", "S:").await?;
    let settings: Value =
        serde_json::from_str(settings.trim_start_matches("S:")).map_err(anyhow::Error::from)?;
    if settings["mode"] != "o" {
        return Err(ApiError::bad(
            "Turn control off before changing sensors or pins",
        ));
    }
    let before = snapshot(&d).await?;
    if before["revision"].as_str() != Some(change.expected_revision.as_str()) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Configuration changed. Refresh the inventory before saving.".into(),
        ));
    }
    let installed = before["installed"].as_array().unwrap();
    let current = if change.index >= 0 {
        installed
            .iter()
            .find(|r| r["i"].as_i64() == Some(change.index) && same_device(r, &change))
    } else {
        if installed.iter().any(|r| same_device(r, &change)) {
            return Err(ApiError::bad("This device is already installed"));
        }
        before["available"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| same_device(r, &change))
    }
    .ok_or_else(|| anyhow::anyhow!("Enheten finns inte i kontrollerns aktuella lista"))?;
    let wanted = prepare(&change, current, installed)?;
    audit(
        &a,
        "pin_config_requested",
        json!({"device":id,"before":before,"requested":wanted}),
    )
    .await?;
    // U modifies one installed slot; the echo alone does not establish success.
    exchange_device(&d, &wire_command(&wanted), "U:").await?;
    let after = snapshot(&d).await?;
    let actual = after["installed"].as_array().unwrap();
    let confirmed = if change.function == 0 {
        !actual
            .iter()
            .any(|r| r["i"] == wanted["i"] && r["f"].as_i64().is_some_and(|f| f > 0))
    } else {
        actual.iter().any(|r| matches(r, &wanted))
    };
    audit(
        &a,
        "pin_config_readback",
        json!({"device":id,"confirmed":confirmed,"requested":wanted,"actual":after}),
    )
    .await?;
    if !confirmed {
        return Err(ApiError::bad(
            "The controller did not confirm the configuration. The change may be partially applied; refresh the actual inventory.",
        ));
    }
    Ok(Json(json!({"confirmed":true,"configuration":after})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    use tokio::io::AsyncBufReadExt;
    fn rows() -> Vec<Value> {
        vec![
            json!({"i":0,"h":1,"p":5,"f":2,"x":1,"c":1,"b":0}),
            json!({"i":1,"h":2,"p":12,"a":"28FF000000000001","f":5,"j":"0.000","v":"6.2","c":1,"b":0}),
        ]
    }
    fn change(rev: String) -> Change {
        Change {
            expected_revision: rev,
            index: 0,
            hardware: 1,
            pin: 5,
            address: String::new(),
            function: 2,
            inverted: false,
            calibration: None,
            confirm_ownership: true,
        }
    }
    struct Fixture {
        _dir: tempfile::TempDir,
        app: App,
        id: String,
        rows: Arc<Mutex<Vec<Value>>>,
        mode: Arc<Mutex<String>>,
        reject: Arc<AtomicBool>,
        writes: Arc<AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Fixture {
        async fn new() -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let installed = Arc::new(Mutex::new(rows()));
            let mode = Arc::new(Mutex::new("f".to_string()));
            let reject = Arc::new(AtomicBool::new(false));
            let writes = Arc::new(AtomicUsize::new(0));
            let (rs, md, rj, ws) = (
                installed.clone(),
                mode.clone(),
                reject.clone(),
                writes.clone(),
            );
            let task = tokio::spawn(async move {
                let (s, _) = listener.accept().await.unwrap();
                let mut stream = BufReader::new(s);
                loop {
                    let mut line = String::new();
                    if stream.read_line(&mut line).await.unwrap_or(0) == 0 {
                        break;
                    }
                    let response = match line.chars().next().unwrap() {
                        's' => format!("S:{}\n", json!({"mode":md.lock().unwrap().clone()})),
                        'c' => "C:{\"tempFormat\":\"C\"}\n".into(),
                        'n' => "N:{\"v\":\"0.2.4\",\"b\":\"e\"}\n".into(),
                        'd' => format!("d:{}\n", json!(*rs.lock().unwrap())),
                        'h' => "h:[{\"i\":-1,\"h\":1,\"p\":14,\"f\":0,\"x\":1}]\n".into(),
                        'U' => {
                            ws.fetch_add(1, Ordering::SeqCst);
                            let row: Value = serde_json::from_str(line[1..].trim()).unwrap();
                            if !rj.load(Ordering::SeqCst) {
                                let mut rows = rs.lock().unwrap();
                                rows.retain(|r| r["i"] != row["i"]);
                                if row["f"] != 0 {
                                    rows.push(row.clone());
                                }
                            }
                            format!("U:{row}\n")
                        }
                        _ => panic!("unexpected hardware command {line}"),
                    };
                    if stream
                        .get_mut()
                        .write_all(response.as_bytes())
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
            let dir = tempfile::tempdir().unwrap();
            let db = crate::db::Db::init(dir.path().join("test.sqlite")).unwrap();
            let id = uuid::Uuid::new_v4().to_string();
            let d = db::Entity {
                id: id.clone(),
                kind: "devices".into(),
                name: "fixture".into(),
                data: json!({"unit":"C","host":"127.0.0.1","port":port,"collection_enabled":true,"control_claimed":true}),
            };
            db.run(move |c| db::put(c, &d)).await.unwrap();
            let app = App {
                db,
                secure_cookie: false,
                proxy_proof: None,
                import_root: Arc::new(dir.path().into()),
                control: true,
                collection: true,
                exports: false,
                failures: Arc::new(Mutex::new(Default::default())),
                auth_slots: Arc::new(tokio::sync::Semaphore::new(2)),
            };
            Self {
                _dir: dir,
                app,
                id,
                rows: installed,
                mode,
                reject,
                writes,
                task,
            }
        }
        async fn finish(self) {
            release(&self.id).await;
            self.task.abort();
        }
    }
    #[test]
    fn revision_ignores_sensor_values_and_row_order_but_detects_configuration_changes() {
        let original = rows();
        let mut changed = original.clone();
        changed[1]["v"] = json!(99);
        changed.reverse();
        assert_eq!(revision(&original), revision(&changed));
        changed[1]["x"] = json!(0);
        assert_ne!(revision(&original), revision(&changed));
    }
    #[test]
    fn wire_order_puts_slot_first() {
        let command = wire_command(&json!({"p":16,"i":1,"h":1,"f":2,"c":1,"b":0,"x":1}));
        assert_eq!(
            command,
            "U{\"i\":1,\"c\":1,\"b\":0,\"f\":2,\"h\":1,\"p\":16,\"x\":1}\n"
        );
    }
    #[test]
    fn changes_validate_hardware_roles_calibration_and_allocate_unused_slot() {
        let installed = rows();
        let mut c = change(String::new());
        let p = prepare(&c, &installed[0], &installed).unwrap();
        assert_eq!(p["x"], 0);
        assert_eq!(p["p"], 5);
        c.hardware = 3;
        assert!(prepare(&c, &installed[0], &installed).is_err());
        c.hardware = 2;
        c.function = 2;
        assert!(prepare(&c, &installed[1], &installed).is_err());
        c.function = 9;
        c.index = 1;
        c.pin = 12;
        c.address = "28FF000000000001".into();
        c.calibration = Some(11.0);
        assert!(prepare(&c, &installed[1], &installed).is_err());
        c.calibration = Some(0.0);
        c.function = 5;
        c.index = -1;
        assert!(prepare(&c, &installed[1], &installed).is_err());
        c = change(String::new());
        c.index = -1;
        c.pin = 14;
        c.function = 7;
        assert_eq!(prepare(&c, &json!({}), &installed).unwrap()["i"], 2);
        c.function = 0;
        assert!(prepare(&c, &json!({}), &installed).is_err());
    }
    #[tokio::test]
    async fn read_inventory_sends_no_configuration_write() {
        let f = Fixture::new().await;
        let result = read(State(f.app.clone()), Path(f.id.clone()))
            .await
            .unwrap_or_else(|e| panic!("{}", e.1))
            .0;
        assert_eq!(result["installed"].as_array().unwrap().len(), 2);
        assert_eq!(result["available"][0]["p"], 14);
        assert_eq!(result["version"]["b"], "e");
        assert_eq!(f.writes.load(Ordering::SeqCst), 0);
        f.finish().await;
    }
    #[tokio::test]
    async fn write_requires_off_mode_revision_and_verified_readback() {
        let f = Fixture::new().await;
        let c = change(revision(&f.rows.lock().unwrap()));
        let error = write(State(f.app.clone()), Path(f.id.clone()), Json(c))
            .await
            .err()
            .unwrap();
        assert!(error.1.contains("Turn control off"));
        assert_eq!(f.writes.load(Ordering::SeqCst), 0);
        *f.mode.lock().unwrap() = "o".into();
        let error = write(
            State(f.app.clone()),
            Path(f.id.clone()),
            Json(change("stale".into())),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error.0, StatusCode::CONFLICT);
        assert_eq!(f.writes.load(Ordering::SeqCst), 0);
        let mut c = change(revision(&f.rows.lock().unwrap()));
        c.confirm_ownership = false;
        assert!(
            write(State(f.app.clone()), Path(f.id.clone()), Json(c))
                .await
                .is_err()
        );
        let c = change(revision(&f.rows.lock().unwrap()));
        let result = write(State(f.app.clone()), Path(f.id.clone()), Json(c))
            .await
            .unwrap_or_else(|e| panic!("{}", e.1))
            .0;
        assert_eq!(result["confirmed"], true);
        assert_eq!(f.rows.lock().unwrap()[1]["x"], 0);
        assert_eq!(f.writes.load(Ordering::SeqCst), 1);
        f.reject.store(true, Ordering::SeqCst);
        let mut c = change(revision(&f.rows.lock().unwrap()));
        c.inverted = true;
        let error = write(State(f.app.clone()), Path(f.id.clone()), Json(c))
            .await
            .err()
            .unwrap();
        assert!(error.1.contains("did not confirm"));
        let n = f
            .app
            .db
            .run(|c| Ok(c.query_row("SELECT COUNT(*) FROM audit", [], |r| r.get::<_, i64>(0))?))
            .await
            .unwrap();
        assert_eq!(n, 4);
        f.reject.store(false, Ordering::SeqCst);
        let mut c = change(revision(&f.rows.lock().unwrap()));
        c.function = 0;
        let result = write(State(f.app.clone()), Path(f.id.clone()), Json(c))
            .await
            .unwrap_or_else(|e| panic!("{}", e.1))
            .0;
        assert_eq!(result["confirmed"], true);
        assert!(f.rows.lock().unwrap().iter().all(|r| r["i"] != 0));
        f.finish().await;
    }
}

// SPDX-License-Identifier: GPL-3.0-only
use crate::{ApiError, App, db};
use axum::{
    Json,
    extract::{Path, State},
};
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{Mutex, OnceLock},
};
#[derive(Clone, Serialize)]
pub struct Entry {
    pub time: i64,
    pub direction: &'static str,
    pub line: String,
    pub truncated: bool,
    #[serde(skip)]
    device: String,
}
static LOG: OnceLock<Mutex<VecDeque<Entry>>> = OnceLock::new();
pub fn record(device: &str, direction: &'static str, line: &str) {
    let mut entries = LOG.get_or_init(Default::default).lock().unwrap();
    if entries.len() >= 500 {
        entries.pop_front();
    }
    entries.push_back(Entry {
        time: chrono::Utc::now().timestamp_millis(),
        direction,
        line: line.chars().take(2048).collect(),
        truncated: line.chars().count() > 2048,
        device: device.into(),
    });
}
fn recent(device: &str) -> Vec<Entry> {
    let entries = LOG.get_or_init(Default::default).lock().unwrap();
    let mut rows: Vec<_> = entries
        .iter()
        .rev()
        .filter(|e| e.device == device)
        .take(200)
        .cloned()
        .collect();
    rows.reverse();
    rows
}
pub async fn read(
    State(a): State<App>,
    Path(id): Path<String>,
) -> Result<Json<Vec<Entry>>, ApiError> {
    let key = id.clone();
    a.db.run(move |c| {
        anyhow::ensure!(db::get(c, &key)?.kind == "devices", "Not a controller");
        Ok(())
    })
    .await?;
    Ok(Json(recent(&id)))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_raw_log_is_scoped_and_keeps_direction() {
        for i in 0..600 {
            record("log-test", "RX", &format!("T:{{\"bt\":{i}}}"));
        }
        let rows = recent("log-test");
        assert_eq!(rows.len(), 200);
        assert_eq!(rows.last().unwrap().line, "T:{\"bt\":599}");
        assert!(recent("other-device").is_empty());
        record("log-test", "TX", &"å".repeat(3000));
        let rows = recent("log-test");
        let last = rows.last().unwrap();
        assert!(last.truncated);
        assert_eq!(last.line.chars().count(), 2048);
        assert_eq!(last.direction, "TX");
    }
}

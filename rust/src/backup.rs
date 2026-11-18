// SPDX-License-Identifier: GPL-3.0-only
use crate::{ApiError, App, db};
use anyhow::{Context, Result};
use axum::{
    Json,
    body::Body,
    extract::{Query, Request, State},
    http::header,
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
fn work(a: &App) -> Result<std::path::PathBuf> {
    let p =
        a.db.0
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join("backup-work");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}
pub async fn download(State(a): State<App>) -> Result<Response, ApiError> {
    let file =
        tempfile::NamedTempFile::new_in(work(&a)?).map_err(|e| ApiError::bad(&e.to_string()))?;
    let file=a.db.run(move|c|{c.backup(rusqlite::DatabaseName::Main,file.path(),None)?;let clean=Connection::open(file.path())?;clean.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; DELETE FROM users; DELETE FROM sessions; DELETE FROM audit; CREATE TABLE IF NOT EXISTS backup_format(version INTEGER); DELETE FROM backup_format; INSERT INTO backup_format VALUES(1); VACUUM;")?;Ok(file)}).await?;
    let input = tokio::fs::File::open(file.path())
        .await
        .map_err(|e| ApiError::bad(&e.to_string()))?;
    drop(file);
    Ok((
        [
            (header::CONTENT_TYPE, "application/vnd.sqlite3"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=yeastcraft-backup.sqlite",
            ),
        ],
        Body::from_stream(tokio_util::io::ReaderStream::new(input)),
    )
        .into_response())
}
#[derive(Deserialize)]
pub struct RestoreQuery {
    #[serde(default)]
    confirm: bool,
    digest: Option<String>,
}
pub async fn upload(
    State(a): State<App>,
    Query(q): Query<RestoreQuery>,
    req: Request,
) -> Result<Response, ApiError> {
    if a.collection || a.control || a.exports {
        return Err(ApiError::bad(
            "Restart the server with --maintenance before restoring",
        ));
    }
    let file =
        tempfile::NamedTempFile::new_in(work(&a)?).map_err(|e| ApiError::bad(&e.to_string()))?;
    let mut output = tokio::fs::File::create(file.path())
        .await
        .map_err(|e| ApiError::bad(&e.to_string()))?;
    let mut stream = req.into_body().into_data_stream();
    let mut size = 0;
    let mut hash = Sha256::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| ApiError::bad(&e.to_string()))?;
        size += chunk.len();
        if size > 1024 * 1024 * 1024 {
            return Err(ApiError::bad("Backup exceeds 1 GiB upload limit"));
        }
        hash.update(&chunk);
        output
            .write_all(&chunk)
            .await
            .map_err(|e| ApiError::bad(&e.to_string()))?;
    }
    output
        .flush()
        .await
        .map_err(|e| ApiError::bad(&e.to_string()))?;
    drop(output);
    let digest = format!("{:x}", hash.finalize());
    if q.confirm && q.digest.as_deref() != Some(&digest) {
        return Err(ApiError::bad("Analyze the exact same backup first"));
    }
    let result=a.db.run(move|c|{let source=Connection::open_with_flags(file.path(),OpenFlags::SQLITE_OPEN_READ_ONLY)?;let integrity:String=source.query_row("PRAGMA integrity_check",[],|r|r.get(0))?;anyhow::ensure!(integrity=="ok","Backup integrity check failed");let version:i64=source.query_row("SELECT version FROM backup_format",[],|r|r.get(0)).context("Not a YeastCraft backup")?;anyhow::ensure!(version==1,"Unknown backup version");
 let mut count=0;for kind in db::KINDS{for e in db::list(&source,kind)?{db::validate(&e)?;count+=1;}}let total:i64=source.query_row("SELECT COUNT(*) FROM entities",[],|r|r.get(0))?;anyhow::ensure!(count==total,"Backup contains unsupported resource kinds");let points:i64=source.query_row("SELECT COUNT(*) FROM points",[],|r|r.get(0))?;
 let (first_measurement,last_measurement):(Option<i64>,Option<i64>)=source.query_row("SELECT MIN(time),MAX(time) FROM points",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
 let sample_names:Vec<String>=["batches","devices","sensors"].into_iter().map(|kind|db::list(&source,kind)).collect::<anyhow::Result<Vec<_>>>()?.into_iter().flatten().take(8).map(|e|e.name).collect();
 if q.confirm{c.execute("ATTACH DATABASE ? AS restore_input",[file.path().to_string_lossy().to_string()])?;let tx=c.transaction()?;tx.execute_batch("DELETE FROM points; DELETE FROM entities; DELETE FROM imports; INSERT INTO entities SELECT * FROM restore_input.entities; INSERT INTO imports SELECT * FROM restore_input.imports; INSERT INTO points SELECT * FROM restore_input.points; UPDATE entities SET data=json_set(data,'$.collection_enabled',json('false'),'$.control_claimed',json('false')) WHERE kind IN ('devices','sensors'); UPDATE entities SET data=json_set(data,'$.enabled',json('false')) WHERE kind='integrations';")?;tx.commit()?;c.execute_batch("DETACH DATABASE restore_input;")?;}
 Ok(json!({"entities":count,"points":points,"first_measurement":first_measurement,"last_measurement":last_measurement,"sample_names":sample_names,"digest":digest,"restored":q.confirm,"collection_enabled":false}))}).await?;
    Ok(Json(result).into_response())
}

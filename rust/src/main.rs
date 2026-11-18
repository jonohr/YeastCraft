// SPDX-License-Identifier: GPL-3.0-only
mod auth;
mod backup;
mod brewfather;
mod calibration;
mod credential_store;
mod db;
mod gravity_profile;
mod import;
mod integrations;
mod profiles;
mod protocol;
mod sensors;
mod tilt;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use db::{Db, Entity};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
#[derive(Clone)]
pub struct App {
    pub db: Db,
    pub secure_cookie: bool,
    pub proxy_proof: Option<Arc<str>>,
    pub import_root: Arc<PathBuf>,
    pub control: bool,
    pub collection: bool,
    pub exports: bool,
    pub failures: Arc<Mutex<HashMap<String, (u32, i64)>>>,
    pub auth_slots: Arc<tokio::sync::Semaphore>,
}
pub struct ApiError(pub StatusCode, pub String);
impl ApiError {
    pub fn bad(s: &str) -> Self {
        Self(StatusCode::BAD_REQUEST, s.into())
    }
}
impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        eprintln!("request failed: {e:#}");
        Self(StatusCode::BAD_REQUEST, e.to_string())
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
async fn origin_check(req: Request, next: Next) -> Response {
    if !matches!(req.method().as_str(), "GET" | "HEAD" | "OPTIONS")
        && let Some(origin) = req
            .headers()
            .get(header::ORIGIN)
            .and_then(|h| h.to_str().ok())
    {
        let host = req
            .headers()
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        if origin != format!("http://{host}") && origin != format!("https://{host}") {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"Cross-origin writes are not allowed"})),
            )
                .into_response();
        }
    }
    let mut r = next.run(req).await;
    r.headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    r.headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    r.headers_mut()
        .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    r.headers_mut()
        .insert(header::X_FRAME_OPTIONS, "DENY".parse().unwrap());
    r.headers_mut().insert(header::CONTENT_SECURITY_POLICY, "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'".parse().unwrap());
    r
}
async fn limited_login(
    State(a): State<App>,
    Json(v): Json<auth::Credentials>,
) -> Result<Response, ApiError> {
    auth::validate_login(&v)?;
    let key = v.username.to_lowercase();
    let now = chrono::Utc::now().timestamp();
    {
        let mut f = a.failures.lock().unwrap();
        f.retain(|_, x| now - x.1 < 600);
        if !f.contains_key(&key) && f.len() >= 1024 {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many login attempts. Try again later.".into(),
            ));
        }
        let ent = f.entry(key.clone()).or_insert((0, now));
        if ent.0 >= 10 {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many attempts. Wait ten minutes.".into(),
            ));
        }
        ent.0 += 1;
    }
    let r = auth::login(State(a.clone()), Json(v)).await;
    if r.is_ok() {
        a.failures.lock().unwrap().remove(&key);
    }
    r
}
fn router(a: App, static_dir: PathBuf) -> Router {
    let protected = Router::new()
        .route("/auth/logout", post(auth::logout))
        .route("/auth/password", post(auth::password))
        .route("/resources/{kind}", get(resources).post(create))
        .route(
            "/resources/{kind}/{id}",
            get(entity).put(update).delete(remove),
        )
        .route("/measurements/{source}", get(measurements))
        .route("/overview", get(overview))
        .route(
            "/brewfather/connection",
            get(brewfather::connection_status)
                .put(brewfather::connect)
                .delete(brewfather::disconnect)
                .layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/brewfather/connection/test",
            post(brewfather::test_connection),
        )
        .route("/brewfather/batches", get(brewfather::batches))
        .route("/brewfather/batches/{id}", get(brewfather::batch))
        .route("/diagnostics", get(diagnostics))
        .route("/backup.sqlite", get(backup::download))
        .route(
            "/restore.sqlite",
            post(backup::upload).layer(DefaultBodyLimit::disable()),
        )
        .route("/backup", get(backup))
        .route("/restore", post(restore))
        .route("/import", post(import_api))
        .route("/devices/{id}/protocol-log", get(protocol::log::read))
        .route("/devices/{id}/command", post(protocol::command))
        .route("/devices/{id}/profile", post(protocol::assign_profile))
        .route(
            "/devices/{id}/pins",
            get(protocol::pins::read).put(protocol::pins::write),
        )
        .route("/sensors/{id}/key", post(sensors::key))
        .route("/sensors/{id}/measurement", post(sensors::manual))
        .route("/sensors/{id}/source", post(sensors::source))
        .route("/sensors/{id}/calibration/points", get(calibration::points))
        .route(
            "/sensors/{id}/calibration/preview",
            post(calibration::preview),
        )
        .route("/sensors/{id}/calibration/apply", post(calibration::apply))
        .route(
            "/sensors/{id}/calibration/restore",
            post(calibration::restore),
        )
        .route("/integrations/{id}/preview", get(integrations::preview))
        .route_layer(middleware::from_fn_with_state(a.clone(), auth::require));
    Router::new()
        .route(
            "/healthz",
            get(|| async { Json(json!({"status":"ok","version":env!("CARGO_PKG_VERSION")})) }),
        )
        .route(
            "/ingest/tilt/{token}",
            post(tilt::cloud).layer(DefaultBodyLimit::max(16384)),
        )
        .route(
            "/ingest/tiltbridge/{token}",
            post(tilt::bridge).layer(DefaultBodyLimit::max(65536)),
        )
        .route(
            "/iSpindel",
            post(sensors::ispindel).layer(DefaultBodyLimit::max(65536)),
        )
        .route(
            "/ispindel",
            post(sensors::ispindel).layer(DefaultBodyLimit::max(65536)),
        )
        .nest(
            "/api/v1",
            protected
                .route("/auth/status", get(auth::status))
                .route(
                    "/auth/setup",
                    post(auth::setup).layer(DefaultBodyLimit::max(4096)),
                )
                .route(
                    "/auth/login",
                    post(limited_login).layer(DefaultBodyLimit::max(4096)),
                ),
        )
        .fallback_service(
            tower_http::services::ServeDir::new(&static_dir).not_found_service(
                tower_http::services::ServeFile::new(static_dir.join("index.html")),
            ),
        )
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .layer(middleware::from_fn(origin_check))
        .with_state(a)
}
async fn resources(
    State(a): State<App>,
    Path(kind): Path<String>,
) -> Result<Json<Vec<Entity>>, ApiError> {
    Ok(Json(a.db.run(move |c| db::list(c, &kind)).await?))
}
async fn entity(
    State(a): State<App>,
    Path((kind, id)): Path<(String, String)>,
) -> Result<Json<Entity>, ApiError> {
    let e = a.db.run(move |c| db::get(c, &id)).await?;
    if e.kind != kind {
        return Err(ApiError(StatusCode::NOT_FOUND, "Hittades inte".into()));
    }
    Ok(Json(e))
}
#[derive(Deserialize)]
struct Input {
    pub name: String,
    #[serde(default = "empty_object")]
    pub data: Value,
}
fn empty_object() -> Value {
    json!({})
}
async fn create(
    State(a): State<App>,
    Path(kind): Path<String>,
    Json(v): Json<Input>,
) -> Result<Json<Entity>, ApiError> {
    let e = Entity {
        id: uuid::Uuid::new_v4().to_string(),
        kind,
        name: v.name,
        data: v.data,
    };
    let e =
        a.db.run(move |c| {
            db::put(c, &e)?;
            Ok(e)
        })
        .await?;
    Ok(Json(e))
}
async fn update(
    State(a): State<App>,
    Path((kind, id)): Path<(String, String)>,
    Json(v): Json<Input>,
) -> Result<Json<Entity>, ApiError> {
    let _operation = if kind == "devices" {
        Some(protocol::operation(&id).lock_owned().await)
    } else {
        None
    };
    if kind == "devices" && v.data["collection_enabled"] != true {
        protocol::release(&id).await;
    }
    let e =
        a.db.run(move |c| {
            let old = db::get(c, &id)?;
            anyhow::ensure!(old.kind == kind, "Resource kind mismatch");
            let mut e = Entity {
                id,
                kind,
                name: v.name,
                data: v.data,
            };
            if e.kind == "devices" {
                e.data["profile_run"] = if e.data["profile"].is_string() {
                    old.data["profile_run"].clone()
                } else {
                    Value::Null
                };
            }
            db::put(c, &e)?;
            Ok(e)
        })
        .await?;
    Ok(Json(e))
}
async fn remove(
    State(a): State<App>,
    Path((kind, id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let _operation = if kind == "devices" {
        Some(protocol::operation(&id).lock_owned().await)
    } else {
        None
    };
    if kind == "devices" {
        protocol::release(&id).await;
    }
    a.db.run(move |c| {
        let tx = c.transaction()?;
        let e = db::get(&tx, &id)?;
        anyhow::ensure!(e.kind == kind, "Resource kind mismatch");
        anyhow::ensure!(
            e.kind != "batches" || e.data["status"] != "active",
            "Finish the active batch before deleting or archiving it"
        );
        let n: i64 = tx.query_row("SELECT COUNT(*) FROM points WHERE source=?", [&id], |r| {
            r.get(0)
        })?;
        anyhow::ensure!(n == 0, "Resource has history; archive it instead");
        for k in db::KINDS {
            for other in db::list(&tx, k)? {
                if other.id != id && other.data.to_string().contains(&id) {
                    anyhow::bail!("Resource is referenced by {}", other.name);
                }
            }
        }
        tx.execute("DELETE FROM entities WHERE id=?", [id])?;
        tx.commit()?;
        Ok(())
    })
    .await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct Page {
    limit: Option<usize>,
}
async fn measurements(
    State(a): State<App>,
    Path(source): Path<String>,
    Query(q): Query<Page>,
) -> Result<Json<Vec<db::Point>>, ApiError> {
    Ok(Json(
        a.db.run(move |c| db::points(c, &source, q.limit.unwrap_or(1500).clamp(2, 10000)))
            .await?,
    ))
}
async fn overview(State(a): State<App>) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        a.db.run(|c| {
            let mut counts = serde_json::Map::new();
            for k in db::KINDS {
                counts.insert(k.to_string(), json!(db::list(c, k)?.len()));
            }
            let n: i64 = c.query_row("SELECT COUNT(*) FROM points", [], |r| r.get(0))?;
            let latest: Option<i64> =
                c.query_row("SELECT MAX(time) FROM points", [], |r| r.get(0))?;
            Ok(json!({"counts":counts,"measurements":n,"latest":latest,"mode":"development"}))
        })
        .await?,
    ))
}
async fn diagnostics(State(a): State<App>) -> Result<Json<Value>, ApiError> {
    let size = std::fs::metadata(a.db.0.as_ref())
        .map(|m| m.len())
        .unwrap_or(0);
    let memory = std::fs::read_to_string("/proc/self/status")
        .unwrap_or_default()
        .lines()
        .find(|s| s.starts_with("VmRSS:"))
        .unwrap_or("unavailable")
        .to_string();
    Ok(Json(
        json!({"version":env!("CARGO_PKG_VERSION"),"database_bytes":size,"memory":memory,"collection_enabled":a.collection,"control_enabled":a.control,"firmware":"not implemented","exports_enabled":a.exports,"ble":"not implemented","serial":"implemented, hardware unverified","import_root":a.import_root.to_string_lossy()}),
    ))
}
async fn backup(State(a): State<App>) -> Result<Response, ApiError> {
    let v =
        a.db.run(|c| {
            let tx = c.transaction()?;
            let n: i64 = tx.query_row("SELECT COUNT(*) FROM points", [], |r| r.get(0))?;
            anyhow::ensure!(n <= 10000, "Use /backup.sqlite for large histories");
            let v = db::snapshot(&tx)?;
            tx.commit()?;
            Ok(v)
        })
        .await?;
    Ok((
        [(
            header::CONTENT_DISPOSITION,
            "attachment; filename=yeastcraft-backup.json",
        )],
        Json(v),
    )
        .into_response())
}
#[derive(Deserialize)]
struct Restore {
    confirm: bool,
    backup: Value,
}
async fn restore(State(a): State<App>, Json(v): Json<Restore>) -> Result<Json<Value>, ApiError> {
    if !v.confirm {
        return Err(ApiError::bad("Restore must be confirmed"));
    }
    if a.collection || a.control || a.exports {
        return Err(ApiError::bad(
            "Stop collection and control before restoring",
        ));
    }
    Ok(Json(a.db.run(move |c| db::restore(c, v.backup)).await?))
}
#[derive(Deserialize)]
struct ImportRequest {
    database: String,
    data: String,
    #[serde(default)]
    apply: bool,
    digest: Option<String>,
    #[serde(default)]
    accept_warnings: bool,
}
async fn import_api(
    State(a): State<App>,
    Json(v): Json<ImportRequest>,
) -> Result<Json<Value>, ApiError> {
    let root = a
        .import_root
        .canonicalize()
        .map_err(|_| ApiError::bad("Import directory does not exist on the server"))?;
    let source = root
        .join(v.database)
        .canonicalize()
        .map_err(|_| ApiError::bad("Databaskopian hittades inte"))?;
    let data = root
        .join(v.data)
        .canonicalize()
        .map_err(|_| ApiError::bad("Datakatalogen hittades inte"))?;
    if !source.starts_with(&root) || !data.starts_with(&root) {
        return Err(ApiError::bad("Import paths must remain inside import root"));
    }
    let work = import::workdir(&a.db);
    let p = tokio::task::spawn_blocking(move || import::plan_in(&source, &data, &work))
        .await
        .map_err(|e| ApiError::bad(&e.to_string()))??;
    if v.apply {
        if v.digest.as_deref() != Some(&p.digest) {
            return Err(ApiError::bad("Source data changed; analyze it again"));
        }
        if !p.warnings.is_empty() && !v.accept_warnings {
            return Err(ApiError::bad("Review and accept the warnings first"));
        }
        Ok(Json(a.db.run(move |c| import::apply(c, p)).await?))
    } else {
        Ok(Json(import::report(&p)))
    }
}
fn operational_flags(args: &[String]) -> anyhow::Result<[bool; 3]> {
    let maintenance = args.iter().any(|arg| arg == "--maintenance");
    let mut enabled = [true; 3];
    for (index, feature) in ["collection", "control", "export"].iter().enumerate() {
        let explicit_enable = args.contains(&format!("--enable-{feature}"));
        let explicit_disable = args.contains(&format!("--disable-{feature}"));
        anyhow::ensure!(
            !(explicit_enable && (maintenance || explicit_disable)),
            "Conflicting startup options for {feature}"
        );
        // Keep the former enable flags valid for existing launch configurations.
        enabled[index] = !maintenance && !explicit_disable;
    }
    Ok(enabled)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "YeastCraft\nserve (default): --db PATH --listen ADDRESS --static DIR --import-root DIR [--secure-cookie] [--disable-internal-auth --proxy-proof-file PATH] [--maintenance] [--disable-collection] [--disable-control] [--disable-export]\nCollection, control and export workers are available by default; configure equipment and destinations in the app. --maintenance disables all three.\nimport: --db PATH --source SQLITE --data DIR [--apply] (dry run by default)\nhealthcheck | --version"
        );
        return Ok(());
    }
    if args.first().is_some_and(|a| a == "--version") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if args.first().is_some_and(|a| a == "healthcheck") {
        use std::io::{Read, Write};
        let mut s = std::net::TcpStream::connect_timeout(
            &"127.0.0.1:8315".parse()?,
            std::time::Duration::from_secs(2),
        )?;
        s.set_read_timeout(Some(std::time::Duration::from_secs(2)))?;
        s.set_write_timeout(Some(std::time::Duration::from_secs(2)))?;
        s.write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
        let mut b = [0u8; 256];
        let n = s.read(&mut b)?;
        anyhow::ensure!(
            std::str::from_utf8(&b[..n])?.starts_with("HTTP/1.1 200"),
            "Health check failed"
        );
        return Ok(());
    }
    let mut i = usize::from(args.first().is_some_and(|a| a == "import" || a == "serve"));
    while i < args.len() {
        match args[i].as_str() {
            "--enable-collection"
            | "--enable-control"
            | "--enable-export"
            | "--disable-collection"
            | "--disable-control"
            | "--disable-export"
            | "--maintenance"
            | "--secure-cookie"
            | "--disable-internal-auth"
            | "--apply" => i += 1,
            "--db" | "--source" | "--data" | "--listen" | "--static" | "--import-root"
            | "--proxy-proof-file" => {
                anyhow::ensure!(
                    args.get(i + 1).is_some_and(|s| !s.starts_with("--")),
                    "Missing value for {}",
                    args[i]
                );
                i += 2;
            }
            _ => anyhow::bail!("Unknown argument: {}", args[i]),
        }
    }

    let opt = |key: &str, default: &str| {
        args.windows(2)
            .find(|a| a[0] == key)
            .map(|a| a[1].clone())
            .unwrap_or(default.into())
    };
    let db = Db::init(PathBuf::from(opt("--db", "state/yeastcraft.sqlite")))?;
    if args.first().is_some_and(|a| a == "import") {
        let src = PathBuf::from(opt("--source", ""));
        let data = PathBuf::from(opt("--data", ""));
        println!(
            "{}",
            serde_json::to_string_pretty(
                &import::cli(&db, &src, &data, args.iter().any(|a| a == "--apply")).await?
            )?
        );
        return Ok(());
    }
    let [collection, control, exports] = operational_flags(&args)?;
    let a = App {
        db,
        secure_cookie: args.iter().any(|a| a == "--secure-cookie"),
        proxy_proof: auth::proxy_config(
            args.iter().any(|a| a == "--disable-internal-auth"),
            args.windows(2)
                .find(|p| p[0] == "--proxy-proof-file")
                .map(|p| std::path::Path::new(&p[1])),
        )?,
        import_root: Arc::new(PathBuf::from(opt("--import-root", "private-import"))),
        control,
        collection,
        exports,
        failures: Arc::new(Mutex::new(HashMap::new())),
        auth_slots: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    if a.collection {
        tokio::spawn(protocol::collect(a.clone()));
    }
    if a.exports {
        tokio::spawn(integrations::worker(a.clone()));
    }
    let listen = opt("--listen", "127.0.0.1:8315");
    let listener = tokio::net::TcpListener::bind(&listen).await?;
    println!("YeastCraft listening on http://{listen}");
    axum::serve(
        listener,
        router(a, PathBuf::from(opt("--static", "ui/dist"))),
    )
    .with_graceful_shutdown(async {
        #[cfg(unix)]
        {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! {_=term.recv()=>{},_=tokio::signal::ctrl_c()=>{}}
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
    })
    .await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    async fn request(
        app: &Router,
        path: &str,
        method: &str,
        body: Value,
        cookie: Option<&str>,
    ) -> (StatusCode, axum::http::HeaderMap, Value) {
        let mut b = axum::http::Request::builder()
            .uri(path)
            .method(method)
            .header("content-type", "application/json");
        if let Some(c) = cookie {
            b = b.header("cookie", c);
        }
        let r = app
            .clone()
            .oneshot(b.body(axum::body::Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = r.status();
        let h = r.headers().clone();
        let bytes = r.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            h,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
    #[tokio::test]
    async fn authenticated_crud_and_backup() {
        let t = tempfile::tempdir().unwrap();
        let a = App {
            db: Db::init(t.path().join("test.sqlite")).unwrap(),
            secure_cookie: false,
            proxy_proof: None,
            import_root: Arc::new(t.path().into()),
            control: false,
            collection: false,
            exports: false,
            failures: Arc::new(Mutex::new(HashMap::new())),
            auth_slots: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        let app = router(a, t.path().into());
        assert_eq!(
            request(&app, "/api/v1/resources/devices", "GET", Value::Null, None)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(&app, "/api/v1/brewfather/batches", "GET", Value::Null, None)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        for method in ["GET", "PUT", "DELETE"] {
            assert_eq!(
                request(
                    &app,
                    "/api/v1/brewfather/connection",
                    method,
                    json!({"user_id":"fake","api_key":"fake"}),
                    None
                )
                .await
                .0,
                StatusCode::UNAUTHORIZED
            );
        }
        let credentials = json!({"username":"test","password":"twelve-characters-test"});
        assert_eq!(
            request(
                &app,
                "/api/v1/auth/setup",
                "POST",
                credentials.clone(),
                None
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            request(
                &app,
                "/api/v1/auth/setup",
                "POST",
                credentials.clone(),
                None
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        let (s, h, _) = request(&app, "/api/v1/auth/login", "POST", credentials, None).await;
        assert_eq!(s, StatusCode::OK);
        let cookie = h[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        assert_eq!(
            request(
                &app,
                "/api/v1/brewfather/batches?after=bad%2Fpath",
                "GET",
                Value::Null,
                Some(cookie)
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            request(
                &app,
                "/api/v1/brewfather/batches",
                "POST",
                Value::Null,
                Some(cookie)
            )
            .await
            .0,
            StatusCode::METHOD_NOT_ALLOWED
        );
        let (status, _, body) = request(
            &app,
            "/api/v1/brewfather/connection",
            "GET",
            Value::Null,
            Some(cookie),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"connected":false,"encrypted":false}));
        let (status, _, body) = request(
            &app,
            "/api/v1/brewfather/connection",
            "PUT",
            json!({"user_id":"bad:user","api_key":"never-return-this"}),
            Some(cookie),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(!body.to_string().contains("never-return-this"));
        let (_, _, e) = request(
            &app,
            "/api/v1/resources/devices",
            "POST",
            json!({"name":"Test","data":{}}),
            Some(cookie),
        )
        .await;
        assert!(e["id"].is_string());
        let (_, _, backup) =
            request(&app, "/api/v1/backup", "GET", Value::Null, Some(cookie)).await;
        assert_eq!(backup["entities"].as_array().unwrap().len(), 1);
        assert!(backup.get("users").is_none());
        let (_, _, out) = request(
            &app,
            "/api/v1/restore",
            "POST",
            json!({"confirm":true,"backup":backup}),
            Some(cookie),
        )
        .await;
        assert_eq!(out["entities"], 1);
        assert_eq!(
            request(
                &app,
                &format!("/api/v1/devices/{}/command", e["id"].as_str().unwrap()),
                "POST",
                json!({"mode":"b","temperature":20}),
                Some(cookie)
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            request(&app, "/api/v1/auth/logout", "POST", json!({}), Some(cookie))
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(
            request(
                &app,
                "/api/v1/resources/devices",
                "GET",
                Value::Null,
                Some(cookie)
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        let (_, h, _) = request(
            &app,
            "/api/v1/auth/login",
            "POST",
            json!({"username":"test","password":"twelve-characters-test"}),
            None,
        )
        .await;
        let cookie = h[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        assert_eq!(
            request(
                &app,
                "/api/v1/auth/password",
                "POST",
                json!({"old_password":"wrong","new_password":"new-password-twelve"}),
                Some(cookie)
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(request(&app,"/api/v1/auth/password","POST",json!({"old_password":"twelve-characters-test","new_password":"new-password-twelve"}),Some(cookie)).await.0,StatusCode::OK);
        assert_eq!(
            request(
                &app,
                "/api/v1/resources/devices",
                "GET",
                Value::Null,
                Some(cookie)
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(
                &app,
                "/api/v1/auth/login",
                "POST",
                json!({"username":"test","password":"new-password-twelve"}),
                None
            )
            .await
            .0,
            StatusCode::OK
        );
    }
}

#[cfg(test)]
mod proxy_auth_tests {
    use super::*;
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    #[tokio::test]
    async fn proxy_mode_requires_proof_and_disables_local_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let proof = "e".repeat(64);
        let db = Db::init(dir.path().join("app.sqlite")).unwrap();
        let app = router(
            App {
                db: db.clone(),
                secure_cookie: true,
                proxy_proof: Some(Arc::from(proof.clone())),
                import_root: Arc::new(dir.path().into()),
                control: false,
                collection: false,
                exports: false,
                failures: Arc::new(Mutex::new(HashMap::new())),
                auth_slots: Arc::new(tokio::sync::Semaphore::new(2)),
            },
            dir.path().into(),
        );
        for (path, value, expected) in [
            ("/api/v1/overview", None, StatusCode::FORBIDDEN),
            ("/api/v1/auth/status", None, StatusCode::FORBIDDEN),
            ("/api/v1/overview", Some("forged"), StatusCode::FORBIDDEN),
            ("/api/v1/overview", Some(proof.as_str()), StatusCode::OK),
        ] {
            let mut req = axum::http::Request::builder()
                .uri(path)
                .header("X-Authentik-Username", "example-user");
            if let Some(value) = value {
                req = req.header("X-YeastCraft-Proxy-Proof", value);
            }
            let res = app
                .clone()
                .oneshot(req.body(axum::body::Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(res.status(), expected);
        }
        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/auth/status")
                    .header("X-YeastCraft-Proxy-Proof", &proof)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let status: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(status["internal_auth"], false);
        assert_eq!(status["authenticated"], true);
        for path in [
            "/api/v1/auth/setup",
            "/api/v1/auth/login",
            "/api/v1/auth/password",
        ] {
            let res=app.clone().oneshot(axum::http::Request::builder().method("POST").uri(path).header("Content-Type","application/json").header("X-YeastCraft-Proxy-Proof",&proof).body(axum::body::Body::from(json!({"username":"should-not-exist","password":"valid-test-password","old_password":"old","new_password":"new-test-password"}).to_string())).unwrap()).await.unwrap();
            assert_eq!(res.status(), StatusCode::CONFLICT);
        }
        assert_eq!(
            db.run(|c| Ok(c.query_row("SELECT COUNT(*) FROM users", [], |r| r.get::<_, i64>(0))?))
                .await
                .unwrap(),
            0
        );
    }
    #[test]
    fn disabling_internal_auth_fails_closed_without_valid_secret() {
        assert!(auth::proxy_config(false, None).unwrap().is_none());
        assert!(auth::proxy_config(true, None).is_err());
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("proof");
        std::fs::write(&file, "short").unwrap();
        assert!(auth::proxy_config(true, Some(&file)).is_err());
        assert!(auth::proxy_config(false, Some(&file)).is_err());
        std::fs::write(&file, "c".repeat(64)).unwrap();
        assert!(auth::proxy_config(true, Some(&file)).unwrap().is_some());
    }
}

#[cfg(test)]
mod security_tests;

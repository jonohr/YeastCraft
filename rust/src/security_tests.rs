// SPDX-License-Identifier: GPL-3.0-only
use super::*;
use axum::body::Body;
use http_body_util::BodyExt;
use tower::ServiceExt;
#[test]
fn operational_defaults_and_explicit_maintenance() {
    let args = |values: &[&str]| values.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(operational_flags(&[]).unwrap(), [true, true, true]);
    assert_eq!(
        operational_flags(&args(&["--maintenance"])).unwrap(),
        [false, false, false]
    );
    assert_eq!(
        operational_flags(&args(&["--disable-control", "--disable-export"])).unwrap(),
        [true, false, false]
    );
    assert_eq!(
        operational_flags(&args(&[
            "--enable-collection",
            "--enable-control",
            "--enable-export"
        ]))
        .unwrap(),
        [true, true, true]
    );
    assert!(operational_flags(&args(&["--maintenance", "--enable-control"])).is_err());
    assert!(operational_flags(&args(&["--disable-export", "--enable-export"])).is_err());
}
fn app(root: &std::path::Path) -> App {
    App {
        db: Db::init(root.join("security.sqlite")).unwrap(),
        secure_cookie: true,
        proxy_proof: None,
        import_root: Arc::new(root.join("imports")),
        control: false,
        collection: false,
        exports: false,
        failures: Arc::new(Mutex::new(HashMap::new())),
        auth_slots: Arc::new(tokio::sync::Semaphore::new(2)),
    }
}
async fn req(
    r: &Router,
    path: &str,
    method: &str,
    data: Value,
    cookie: Option<&str>,
    origin: Option<&str>,
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let mut b = axum::http::Request::builder()
        .uri(path)
        .method(method)
        .header("Content-Type", "application/json");
    if let Some(cookie) = cookie {
        b = b.header("Cookie", cookie);
    }
    if let Some(origin) = origin {
        b = b.header("Origin", origin);
    }
    let response = r
        .clone()
        .oneshot(b.body(Body::from(data.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        headers,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn login(r: &Router) -> String {
    let credentials = json!({"username":"admin","password":"test-only-long-password"});
    assert_eq!(
        req(
            r,
            "/api/v1/auth/setup",
            "POST",
            credentials.clone(),
            None,
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, headers, _) = req(r, "/api/v1/auth/login", "POST", credentials, None, None).await;
    assert_eq!(status, StatusCode::OK);
    let cookie = headers[header::SET_COOKIE].to_str().unwrap();
    for flag in ["HttpOnly", "SameSite=Strict", "Secure"] {
        assert!(cookie.contains(flag));
    }
    cookie.split(';').next().unwrap().to_owned()
}
#[tokio::test]
async fn anonymous_limits_and_bounded_login_tracking() {
    let temp = tempfile::tempdir().unwrap();
    let a = app(temp.path());
    let r = router(a.clone(), temp.path().into());
    assert_eq!(
        req(
            &r,
            "/api/v1/auth/login",
            "POST",
            json!({"username":"x".repeat(81),"password":"x"}),
            None,
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert!(a.failures.lock().unwrap().is_empty());
    assert_eq!(
        req(
            &r,
            "/api/v1/auth/login",
            "POST",
            json!({"username":"x","password":"x".repeat(5000)}),
            None,
            None
        )
        .await
        .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        req(
            &r,
            "/iSpindel",
            "POST",
            json!({"token":"x","payload":"x".repeat(70000)}),
            None,
            None
        )
        .await
        .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let now = chrono::Utc::now().timestamp();
    for i in 0..1024 {
        a.failures
            .lock()
            .unwrap()
            .insert(format!("user{i}"), (1, now));
    }
    assert_eq!(
        req(
            &r,
            "/api/v1/auth/login",
            "POST",
            json!({"username":"different","password":"test"}),
            None,
            None
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(a.failures.lock().unwrap().len(), 1024);
}
#[tokio::test]
async fn password_work_is_bounded_and_sessions_revoked_on_password_change() {
    let temp = tempfile::tempdir().unwrap();
    let a = app(temp.path());
    let r = router(a.clone(), temp.path().into());
    let cookie = login(&r).await;
    let one = a.auth_slots.clone().acquire_owned().await.unwrap();
    let two = a.auth_slots.clone().acquire_owned().await.unwrap();
    for (path, body) in [
        (
            "/api/v1/auth/login",
            json!({"username":"admin","password":"test-only-long-password"}),
        ),
        (
            "/api/v1/auth/setup",
            json!({"username":"other","password":"test-only-long-password"}),
        ),
        (
            "/api/v1/auth/password",
            json!({"old_password":"test-only-long-password","new_password":"another-test-password"}),
        ),
    ] {
        assert_eq!(
            req(&r, path, "POST", body, Some(&cookie), None).await.0,
            StatusCode::TOO_MANY_REQUESTS
        );
    }
    drop((one, two));
    assert_eq!(req(&r,"/api/v1/auth/password","POST",json!({"old_password":"test-only-long-password","new_password":"another-test-password"}),Some(&cookie),None).await.0,StatusCode::OK);
    assert_eq!(
        req(
            &r,
            "/api/v1/resources/devices",
            "GET",
            Value::Null,
            Some(&cookie),
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        req(
            &r,
            "/api/v1/auth/login",
            "POST",
            json!({"username":"admin","password":"another-test-password"}),
            None,
            None
        )
        .await
        .0,
        StatusCode::OK
    );
}
#[tokio::test]
async fn protected_routes_origin_headers_and_uniform_invalid_login() {
    let temp = tempfile::tempdir().unwrap();
    let a = app(temp.path());
    let r = router(a, temp.path().into());
    let _cookie = login(&r).await;
    for path in [
        "/api/v1/resources/sensors",
        "/api/v1/diagnostics",
        "/api/v1/backup.sqlite",
        "/api/v1/devices/missing/protocol-log",
    ] {
        assert_eq!(
            req(&r, path, "GET", Value::Null, None, None).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    let (_, h, _) = req(&r, "/healthz", "GET", Value::Null, None, None).await;
    assert_eq!(h[header::X_FRAME_OPTIONS], "DENY");
    assert_eq!(h[header::REFERRER_POLICY], "no-referrer");
    assert!(
        h[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'")
    );
    let data = json!({"username":"admin","password":"wrong"});
    assert_eq!(
        req(
            &r,
            "/api/v1/auth/login",
            "POST",
            data.clone(),
            None,
            Some("https://attacker.invalid")
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let known = req(&r, "/api/v1/auth/login", "POST", data, None, None).await;
    let unknown = req(
        &r,
        "/api/v1/auth/login",
        "POST",
        json!({"username":"' OR 1=1 --","password":"wrong"}),
        None,
        None,
    )
    .await;
    assert_eq!(known.0, StatusCode::UNAUTHORIZED);
    assert_eq!(known.0, unknown.0);
    assert_eq!(known.2, unknown.2);
}
#[tokio::test]
async fn active_batch_cannot_be_deleted_even_without_history() {
    let temp = tempfile::tempdir().unwrap();
    let a = app(temp.path());
    let r = router(a.clone(), temp.path().into());
    let cookie = login(&r).await;
    let c = a.db.open().unwrap();
    let mut e = Entity {
        id: "batch".into(),
        kind: "batches".into(),
        name: "Test".into(),
        data: json!({"status":"active"}),
    };
    db::put(&c, &e).unwrap();
    assert_eq!(
        req(
            &r,
            "/api/v1/resources/batches/batch",
            "DELETE",
            Value::Null,
            Some(&cookie),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert!(db::get(&c, "batch").is_ok());
    e.data["status"] = json!("completed");
    db::put(&c, &e).unwrap();
    assert_eq!(
        req(
            &r,
            "/api/v1/resources/batches/batch",
            "DELETE",
            Value::Null,
            Some(&cookie),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
}
#[cfg(unix)]
#[tokio::test]
async fn legacy_import_rejects_symlink_escape_from_import_root() {
    let temp = tempfile::tempdir().unwrap();
    let a = app(temp.path());
    std::fs::create_dir_all(a.import_root.as_ref()).unwrap();
    std::fs::write(temp.path().join("outside.sqlite"), b"not a database").unwrap();
    std::os::unix::fs::symlink(
        temp.path().join("outside.sqlite"),
        a.import_root.join("escape.sqlite"),
    )
    .unwrap();
    let r = router(a, temp.path().into());
    let cookie = login(&r).await;
    let (status, _, body) = req(
        &r,
        "/api/v1/import",
        "POST",
        json!({"database":"escape.sqlite","data":"."}),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "Import paths must remain inside import root");
}

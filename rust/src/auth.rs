// SPDX-License-Identifier: GPL-3.0-only
use crate::{ApiError, App};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json,
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};
use subtle::ConstantTimeEq;
#[derive(Deserialize)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}
pub fn digest(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
pub fn proxy_config(
    disable_internal: bool,
    path: Option<&Path>,
) -> anyhow::Result<Option<Arc<str>>> {
    if !disable_internal {
        anyhow::ensure!(
            path.is_none(),
            "--proxy-proof-file requires --disable-internal-auth"
        );
        return Ok(None);
    }
    let path =
        path.ok_or_else(|| anyhow::anyhow!("Disabling internal auth requires --proxy-proof-file"))?;
    let proof = std::fs::read_to_string(path)?;
    let proof = proof.trim();
    anyhow::ensure!(
        proof.len() == 64 && proof.bytes().all(|b| b.is_ascii_hexdigit()),
        "Proxy proof must be a 64-character hex secret"
    );
    Ok(Some(Arc::from(proof)))
}
fn proxy_valid(a: &App, h: &HeaderMap) -> bool {
    let Some(expected) = &a.proxy_proof else {
        return false;
    };
    let Some(actual) = h.get("x-fermentrack-proxy-proof") else {
        return false;
    };
    let want: [u8; 32] = Sha256::digest(expected.as_bytes()).into();
    let got: [u8; 32] = Sha256::digest(actual.as_bytes()).into();
    bool::from(want.ct_eq(&got))
}
fn local_auth_only(a: &App) -> Result<(), ApiError> {
    if a.proxy_proof.is_some() {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Internal sign-in is disabled. Access is managed by your identity provider.".into(),
        ));
    }
    Ok(())
}
pub async fn status(
    State(a): State<App>,
    h: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    if a.proxy_proof.is_some() {
        if !proxy_valid(&a, &h) {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "Open the app through the protected proxy".into(),
            ));
        }
        return Ok(Json(
            json!({"configured":true,"authenticated":true,"internal_auth":false,"logout_url":"/outpost.goauthentik.io/sign_out","version":env!("CARGO_PKG_VERSION")}),
        ));
    }
    let configured = a
        .db
        .run(|c| Ok(c.query_row("SELECT COUNT(*) FROM users", [], |r| r.get::<_, i64>(0))? > 0))
        .await?;
    Ok(Json(
        json!({"configured":configured,"internal_auth":true,"authenticated":session(&a,&h).await,"version":env!("CARGO_PKG_VERSION")}),
    ))
}
async fn session(a: &App, h: &HeaderMap) -> bool {
    let token = h
        .get(header::COOKIE)
        .and_then(|x| x.to_str().ok())
        .and_then(|s| {
            s.split(';')
                .find_map(|x| x.trim().strip_prefix("ft_session="))
        })
        .map(digest);
    if let Some(t) = token {
        a.db.run(move |c| {
            Ok(c.query_row(
                "SELECT 1 FROM sessions WHERE token=? AND expires>?",
                rusqlite::params![t, chrono::Utc::now().timestamp()],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .is_some())
        })
        .await
        .unwrap_or(false)
    } else {
        false
    }
}
pub async fn require(State(a): State<App>, req: Request, next: Next) -> Response {
    let allowed = if a.proxy_proof.is_some() {
        proxy_valid(&a, req.headers())
    } else {
        session(&a, req.headers()).await
    };
    if allowed {
        next.run(req).await
    } else {
        (
            if a.proxy_proof.is_some() {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::UNAUTHORIZED
            },
            Json(json!({"error":"Sign in through the protected app entrypoint"})),
        )
            .into_response()
    }
}
pub async fn setup(
    State(a): State<App>,
    Json(v): Json<Credentials>,
) -> Result<Json<serde_json::Value>, ApiError> {
    local_auth_only(&a)?;
    if v.username.trim().is_empty()
        || v.username.len() > 80
        || v.password.len() < 12
        || v.password.len() > 256
    {
        return Err(ApiError::bad(
            "Enter a username and a password with 12–256 characters",
        ));
    }
    a.db.run(move |c| {
        let tx = c.transaction()?;
        let n: i64 = tx.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
        anyhow::ensure!(n == 0, "Installation already configured");
        let salt = SaltString::encode_b64(uuid::Uuid::new_v4().as_bytes())
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let hash = Argon2::default()
            .hash_password(v.password.as_bytes(), &salt)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?
            .to_string();
        tx.execute(
            "INSERT INTO users VALUES(?,?)",
            rusqlite::params![v.username.trim(), hash],
        )?;
        tx.commit()?;
        Ok(())
    })
    .await?;
    Ok(Json(json!({"configured":true})))
}
pub async fn login(State(a): State<App>, Json(v): Json<Credentials>) -> Result<Response, ApiError> {
    local_auth_only(&a)?;
    if v.password.len() > 256 {
        return Err(ApiError::bad("Ogiltiga uppgifter"));
    }
    let token = uuid::Uuid::new_v4().to_string() + &uuid::Uuid::new_v4().to_string();
    let hashed = digest(&token);
    let success =
        a.db.run(move |c| {
            let hash = c
                .query_row("SELECT hash FROM users WHERE name=?", [&v.username], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?;
            // Perform the expensive verification even for unknown users.
            let salt = SaltString::encode_b64(b"fermentrackdummy!").unwrap();
            let dummy = Argon2::default()
                .hash_password(b"invalid-password", &salt)
                .unwrap()
                .to_string();
            let parsed = PasswordHash::new(hash.as_deref().unwrap_or(&dummy))
                .map_err(|e| anyhow::anyhow!(e.to_string()))?;
            let ok = Argon2::default()
                .verify_password(v.password.as_bytes(), &parsed)
                .is_ok()
                && hash.is_some();
            if ok {
                c.execute(
                    "DELETE FROM sessions WHERE expires<?",
                    [chrono::Utc::now().timestamp()],
                )?;
                c.execute(
                    "INSERT INTO sessions VALUES(?,?,?)",
                    rusqlite::params![hashed, v.username, chrono::Utc::now().timestamp() + 86400],
                )?;
            }
            Ok(ok)
        })
        .await?;
    if !success {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Incorrect username or password".into(),
        ));
    }
    let cookie = format!(
        "ft_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400{}",
        if a.secure_cookie { "; Secure" } else { "" }
    );
    Ok(([(header::SET_COOKIE, cookie)], Json(json!({"ok":true}))).into_response())
}
pub async fn logout(State(a): State<App>, h: HeaderMap) -> Result<Response, ApiError> {
    if a.proxy_proof.is_some() {
        return Ok(
            Json(json!({"ok":true,"logout_url":"/outpost.goauthentik.io/sign_out"}))
                .into_response(),
        );
    }
    if let Some(t) = h
        .get(header::COOKIE)
        .and_then(|x| x.to_str().ok())
        .and_then(|s| {
            s.split(';')
                .find_map(|x| x.trim().strip_prefix("ft_session="))
        })
    {
        let t = digest(t);
        a.db.run(move |c| {
            c.execute("DELETE FROM sessions WHERE token=?", [t])?;
            Ok(())
        })
        .await?;
    }
    Ok((
        [(
            header::SET_COOKIE,
            "ft_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        )],
        Json(json!({"ok":true})),
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct PasswordChange {
    old_password: String,
    new_password: String,
}
pub async fn password(
    State(a): State<App>,
    h: HeaderMap,
    Json(v): Json<PasswordChange>,
) -> Result<Json<serde_json::Value>, ApiError> {
    local_auth_only(&a)?;
    if v.new_password.len() < 12 || v.new_password.len() > 256 || v.old_password.len() > 256 {
        return Err(ApiError::bad("Password must contain 12–256 characters"));
    }
    let token = h
        .get(header::COOKIE)
        .and_then(|x| x.to_str().ok())
        .and_then(|s| {
            s.split(';')
                .find_map(|x| x.trim().strip_prefix("ft_session="))
        })
        .map(digest)
        .ok_or_else(|| ApiError::bad("Session saknas"))?;
    a.db.run(move|c|{let tx=c.transaction()?;let (name,hash):(String,String)=tx.query_row("SELECT u.name,u.hash FROM users u JOIN sessions s ON s.name=u.name WHERE s.token=? AND s.expires>?",rusqlite::params![token,chrono::Utc::now().timestamp()],|r|Ok((r.get(0)?,r.get(1)?)))?;let parsed=PasswordHash::new(&hash).map_err(|e|anyhow::anyhow!(e.to_string()))?;anyhow::ensure!(Argon2::default().verify_password(v.old_password.as_bytes(),&parsed).is_ok(),"Current password is incorrect");let salt=SaltString::encode_b64(uuid::Uuid::new_v4().as_bytes()).map_err(|e|anyhow::anyhow!(e.to_string()))?;let hash=Argon2::default().hash_password(v.new_password.as_bytes(),&salt).map_err(|e|anyhow::anyhow!(e.to_string()))?.to_string();tx.execute("UPDATE users SET hash=? WHERE name=?",rusqlite::params![hash,name])?;tx.execute("DELETE FROM sessions WHERE name=?",[name])?;tx.commit()?;Ok(())}).await?;
    Ok(Json(json!({"changed":true,"reauthenticate":true})))
}

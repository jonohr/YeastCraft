// SPDX-License-Identifier: GPL-3.0-only
//! Authenticated encryption before credentials enter SQLite. Never logs values.
use crate::db::Db;
use anyhow::{Result, anyhow, ensure};
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::{Path, PathBuf},
};
const AAD: &[u8] = b"YeastCraft/Brewfather/credentials/v1";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    pub user_id: String,
    pub api_key: String,
}
impl Credentials {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.user_id.is_empty()
                && self.user_id.len() <= 256
                && !self.user_id.contains(':')
                && !self.user_id.chars().any(char::is_control),
            "Invalid User ID"
        );
        ensure!(
            !self.api_key.is_empty()
                && self.api_key.len() <= 1024
                && !self.api_key.chars().any(char::is_control),
            "Invalid API key"
        );
        Ok(())
    }
}
pub fn key_path(db: &Db) -> PathBuf {
    std::env::var_os("YEASTCRAFT_CREDENTIAL_KEY_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| db.0.with_extension("credentials.key"))
}
fn key(path: &Path, create: bool) -> Result<[u8; 32]> {
    if !path.exists() && create {
        let parent = path
            .parent()
            .ok_or_else(|| anyhow!("Missing key directory"))?;
        std::fs::create_dir_all(parent)?;
        let mut bytes = [0; 32];
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| anyhow!("Random generator unavailable"))?;
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        temp.write_all(&bytes)?;
        temp.as_file().sync_all()?;
        match temp.persist_noclobber(path) {
            Ok(_) => {}
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(anyhow!("Cannot create encryption key")),
        }
    }
    let meta = std::fs::symlink_metadata(path)?;
    ensure!(meta.is_file(), "Encryption key must be a regular file");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            meta.permissions().mode() & 0o077 == 0,
            "Encryption key permissions must be owner-only"
        );
    }
    std::fs::read(path)?
        .try_into()
        .map_err(|_| anyhow!("Invalid encryption key length"))
}
fn cipher(k: &[u8; 32]) -> Result<aead::LessSafeKey> {
    Ok(aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, k)
            .map_err(|_| anyhow!("Invalid encryption key"))?,
    ))
}
fn seal(k: &[u8; 32], data: &Credentials) -> Result<Vec<u8>> {
    let mut nonce = [0; 12];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| anyhow!("Random generator unavailable"))?;
    let mut plain = serde_json::to_vec(data)?;
    cipher(k)?
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(AAD),
            &mut plain,
        )
        .map_err(|_| anyhow!("Encryption failed"))?;
    let mut out = vec![1];
    out.extend(nonce);
    out.extend(plain);
    Ok(out)
}
fn open(k: &[u8; 32], blob: &[u8]) -> Result<Credentials> {
    ensure!(
        blob.len() >= 29 && blob[0] == 1,
        "Unsupported encrypted record"
    );
    let nonce = blob[1..13].try_into().unwrap();
    let mut data = blob[13..].to_vec();
    let plain = cipher(k)?
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(AAD),
            &mut data,
        )
        .map_err(|_| anyhow!("Cannot decrypt credentials"))?;
    let value: Credentials = serde_json::from_slice(plain)?;
    value.validate()?;
    Ok(value)
}
fn table(c: &rusqlite::Connection) -> Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS service_credentials(service TEXT PRIMARY KEY, ciphertext BLOB NOT NULL)")?;
    Ok(())
}
pub fn load(db: &Db, path: &Path) -> Result<Option<Credentials>> {
    let c = db.open()?;
    table(&c)?;
    let blob: Option<Vec<u8>> = c
        .query_row(
            "SELECT ciphertext FROM service_credentials WHERE service='brewfather'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    blob.map(|b| open(&key(path, false)?, &b)).transpose()
}
pub fn store(db: &Db, path: &Path, value: &Credentials) -> Result<()> {
    value.validate()?;
    let c = db.open()?;
    table(&c)?;
    let exists: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM service_credentials WHERE service='brewfather')",
        [],
        |r| r.get(0),
    )?;
    // Never silently generate a replacement key for existing encrypted data.
    let k = key(path, !exists)?;
    let blob = seal(&k, value)?;
    c.execute("INSERT INTO service_credentials VALUES('brewfather',?1) ON CONFLICT(service) DO UPDATE SET ciphertext=excluded.ciphertext",[blob])?;
    Ok(())
}
pub fn remove(db: &Db) -> Result<()> {
    let c = db.open()?;
    table(&c)?;
    c.execute(
        "DELETE FROM service_credentials WHERE service='brewfather'",
        [],
    )?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Credentials {
        Credentials {
            user_id: "synthetic-user".into(),
            api_key: "synthetic-secret-key".into(),
        }
    }
    #[test]
    fn encrypted_roundtrip_restart_tamper_and_wrong_key() {
        let k = [7; 32];
        let c = seal(&k, &sample()).unwrap();
        let d = seal(&k, &sample()).unwrap();
        assert_ne!(c, d);
        assert!(!c.windows(20).any(|w| w == b"synthetic-secret-key"));
        assert_eq!(open(&k, &c).unwrap().api_key, sample().api_key);
        assert!(open(&[8; 32], &c).is_err());
        let mut t = c.clone();
        t[18] ^= 1;
        assert!(open(&k, &t).is_err());
    }
    #[test]
    fn persistence_separate_key_and_no_plaintext() {
        let t = tempfile::tempdir().unwrap();
        let db = Db::init(t.path().join("test.sqlite")).unwrap();
        let kp = t.path().join("master.key");
        store(&db, &kp, &sample()).unwrap();
        let reopened = Db::init(t.path().join("test.sqlite")).unwrap();
        assert_eq!(
            load(&reopened, &kp).unwrap().unwrap().user_id,
            "synthetic-user"
        );
        for f in std::fs::read_dir(t.path()).unwrap() {
            let b = std::fs::read(f.unwrap().path()).unwrap();
            assert!(!String::from_utf8_lossy(&b).contains("synthetic-secret-key"));
        }
        std::fs::remove_file(&kp).unwrap();
        assert!(load(&db, &kp).is_err());
        assert!(store(&db, &kp, &sample()).is_err());
        assert!(!kp.exists());
        remove(&db).unwrap();
        assert!(load(&db, &kp).unwrap().is_none());
    }
    #[test]
    fn invalid_credentials_rejected() {
        assert!(
            Credentials {
                user_id: "a:b".into(),
                api_key: "x".into()
            }
            .validate()
            .is_err()
        );
        assert!(
            Credentials {
                user_id: "a".into(),
                api_key: "".into()
            }
            .validate()
            .is_err()
        );
    }
}

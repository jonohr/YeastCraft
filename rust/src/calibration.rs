// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    ApiError, App, auth,
    db::{self, Entity},
};
use anyhow::{Context, Result};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Reference {
    pub id: String,
    pub time: i64,
    pub angle: f64,
    pub gravity: f64,
    pub reported_gravity: Option<f64>,
    pub reported_unit: String,
}
#[derive(Serialize, Debug)]
pub struct Fit {
    pub degree: usize,
    pub count: usize,
    pub coefficients: [f64; 4],
    pub formula: String,
    pub rmse: f64,
    pub max_error: f64,
    pub angle_min: f64,
    pub angle_max: f64,
    pub sg_min: f64,
    pub sg_max: f64,
    pub residuals: Vec<Value>,
    pub warnings: Vec<String>,
}
pub fn evaluate(c: &[f64; 4], x: f64) -> f64 {
    ((c[3] * x + c[2]) * x + c[1]) * x + c[0]
}
pub fn fit(points: &[Reference], degree: usize) -> Result<Fit> {
    anyhow::ensure!([2, 3].contains(&degree), "Choose a quadratic or cubic fit");
    anyhow::ensure!(
        points.len() > degree && points.len() <= 500,
        "Select at least degree + 1 references and at most 500 points"
    );
    anyhow::ensure!(
        points.iter().all(|p| p.angle.is_finite()
            && (0.0..=180.0).contains(&p.angle)
            && p.gravity.is_finite()
            && (0.5..=2.0).contains(&p.gravity)),
        "Ogiltig vinkel eller SG"
    );
    let lo = points.iter().map(|p| p.angle).fold(f64::INFINITY, f64::min);
    let hi = points
        .iter()
        .map(|p| p.angle)
        .fold(f64::NEG_INFINITY, f64::max);
    let gl = points
        .iter()
        .map(|p| p.gravity)
        .fold(f64::INFINITY, f64::min);
    let gh = points
        .iter()
        .map(|p| p.gravity)
        .fold(f64::NEG_INFINITY, f64::max);
    anyhow::ensure!(
        hi - lo >= 1.0 && gh - gl >= 0.005,
        "References need a wider spread of angle and gravity"
    );
    let center = (hi + lo) / 2.0;
    let scale = (hi - lo) / 2.0;
    // Reorthogonalized modified Gram-Schmidt on centered/scaled powers. Only four
    // columns are needed; no matrix service or heavy numerical runtime.
    let mut q: Vec<Vec<f64>> = Vec::new();
    let mut r = [[0.0; 4]; 4];
    let mut j = 0;
    while j <= degree {
        let mut col = points
            .iter()
            .map(|p| ((p.angle - center) / scale).powi(j as i32))
            .collect::<Vec<_>>();
        for _ in 0..2 {
            for i in 0..j {
                let dot = q[i].iter().zip(&col).map(|(a, b)| a * b).sum::<f64>();
                r[i][j] += dot;
                for (value, axis) in col.iter_mut().zip(&q[i]) {
                    *value -= dot * axis;
                }
            }
        }
        r[j][j] = col.iter().map(|v| v * v).sum::<f64>().sqrt();
        anyhow::ensure!(
            r[j][j] > 1e-10,
            "The fit is ambiguous; more distinct angles are required"
        );
        for value in &mut col {
            *value /= r[j][j];
        }
        q.push(col);
        j += 1;
    }
    let mut normalized = [0.0; 4];
    for i in (0..=degree).rev() {
        normalized[i] = (q[i]
            .iter()
            .zip(points)
            .map(|(v, p)| v * p.gravity)
            .sum::<f64>()
            - ((i + 1)..=degree)
                .map(|j| r[i][j] * normalized[j])
                .sum::<f64>())
            / r[i][i];
    }
    let binomial = [
        [1., 0., 0., 0.],
        [1., 1., 0., 0.],
        [1., 2., 1., 0.],
        [1., 3., 3., 1.],
    ];
    let mut c = [0.0; 4];
    for i in 0..=degree {
        for (k, value) in c.iter_mut().enumerate().take(i + 1) {
            *value += normalized[i] * binomial[i][k] * (-center).powi((i - k) as i32)
                / scale.powi(i as i32);
        }
    }
    anyhow::ensure!(
        c.iter().all(|v| v.is_finite()),
        "Formeln blev inte numeriskt giltig"
    );
    let residuals=points.iter().map(|p|{let predicted=evaluate(&c,p.angle);json!({"id":p.id,"angle":p.angle,"reference":p.gravity,"predicted":predicted,"error":predicted-p.gravity})}).collect::<Vec<_>>();
    let rmse = (residuals
        .iter()
        .map(|p| p["error"].as_f64().unwrap().powi(2))
        .sum::<f64>()
        / points.len() as f64)
        .sqrt();
    let max_error = residuals
        .iter()
        .map(|p| p["error"].as_f64().unwrap().abs())
        .fold(0.0, f64::max);
    let mut warnings = vec![
        "The formula is fitted within the reference angle range; extrapolation is uncertain."
            .into(),
    ];
    if hi - lo < 10.0 || gh - gl < 0.03 {
        warnings.push("References cover a narrow range. Measure more widely spaced points.".into());
    }
    if max_error > 0.005 {
        warnings
            .push("A reference has a large residual. Check measurements before applying.".into());
    }
    let formula = (0..=degree)
        .map(|i| match i {
            0 => format!("({:.15e})", c[i]),
            1 => format!("({:.15e})*tilt", c[i]),
            _ => format!("({:.15e})*tilt^{i}", c[i]),
        })
        .collect::<Vec<_>>()
        .join("+");
    Ok(Fit {
        degree,
        count: points.len(),
        coefficients: c,
        formula,
        rmse,
        max_error,
        angle_min: lo,
        angle_max: hi,
        sg_min: gl,
        sg_max: gh,
        residuals,
        warnings,
    })
}
fn sensor(c: &rusqlite::Connection, id: &str) -> Result<Entity> {
    let e = db::get(c, id)?;
    anyhow::ensure!(
        e.kind == "sensors" && e.data["sensor_type"] == "ispindel",
        "Select an iSpindel sensor"
    );
    Ok(e)
}
fn references(c: &rusqlite::Connection, id: &str) -> Result<Vec<Reference>> {
    let mut stmt=c.prepare("SELECT time,sequence,values_json FROM points WHERE source=? AND json_extract(values_json,'$.reading_source')='manual' AND json_extract(values_json,'$.calibration_reference')=1 ORDER BY time,sequence LIMIT 501")?;
    let rows = stmt.query_map([id], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut result = Vec::new();
    for row in rows {
        let (time, sequence, text) = row?;
        let v: Value = serde_json::from_str(&text)?;
        result.push(Reference {
            id: format!("{time}:{sequence}"),
            time,
            angle: v["angle"].as_f64().context("Referens saknar vinkel")?,
            gravity: v["reference_gravity"]
                .as_f64()
                .or(v["gravity"].as_f64())
                .context("Referens saknar SG")?,
            reported_gravity: v["ispindel_gravity"].as_f64(),
            reported_unit: v["ispindel_gravity_unit"]
                .as_str()
                .unwrap_or("unknown")
                .into(),
        });
    }
    anyhow::ensure!(
        result.len() <= 500,
        "More than 500 calibration references; export and narrow the selection"
    );
    Ok(result)
}
pub async fn points(State(a): State<App>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    Ok(Json(a.db.run(move|c|{let e=sensor(c,&id)?;let rows=references(c,&id)?;Ok(json!({"points":rows,"active_id":e.data["active_ispindel_calibration"],"source":e.data["gravity_source"]}))}).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub degree: usize,
    pub points: Option<Vec<String>>,
    pub expected_revision: Option<String>,
    #[serde(default)]
    pub confirm_apply: bool,
}
fn preview_value(
    c: &rusqlite::Connection,
    id: &str,
    selection: &Selection,
) -> Result<(Fit, String, Vec<Reference>)> {
    let e = sensor(c, id)?;
    let all = references(c, id)?;
    let selected = if let Some(ids) = &selection.points {
        anyhow::ensure!(ids.len() <= 500, "Too many references");
        let rows = all
            .iter()
            .filter(|p| ids.contains(&p.id))
            .cloned()
            .collect::<Vec<_>>();
        anyhow::ensure!(
            rows.len() == ids.len(),
            "A reference is missing or selected more than once"
        );
        rows
    } else {
        all.clone()
    };
    let revision=auth::digest(&json!({"all":all,"selected":selected,"degree":selection.degree,"active":e.data["active_ispindel_calibration"],"source":e.data["gravity_source"],"unit":e.data["reported_gravity_unit"]}).to_string());
    Ok((fit(&selected, selection.degree)?, revision, selected))
}
pub async fn preview(
    State(a): State<App>,
    Path(id): Path<String>,
    Json(v): Json<Selection>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        a.db.run(move |c| {
            let (fit, revision, points) = preview_value(c, &id, &v)?;
            Ok(json!({"fit":fit,"revision":revision,"points":points}))
        })
        .await?,
    ))
}
pub async fn apply(
    State(a): State<App>,
    Path(id): Path<String>,
    Json(v): Json<Selection>,
) -> Result<Json<Value>, ApiError> {
    if !v.confirm_apply {
        return Err(ApiError::bad(
            "Confirm the new server calibration should be applied",
        ));
    }
    let result=a.db.run(move|c|{
        let tx=c.transaction()?;let(fit,revision,points)=preview_value(&tx,&id,&v)?;
        if v.expected_revision.as_deref()!=Some(&revision) {return Ok(None);}
        let mut e=sensor(&tx,&id)?;let previous=e.data["active_ispindel_calibration"].clone();
        if let Some(old)=previous.as_str(){let mut old=db::get(&tx,old)?;anyhow::ensure!(old.kind=="calibrations" && old.data["sensor"]==id,"Calibration belongs to another sensor");old.data["enabled"]=json!(false);db::put(&tx,&old)?;}
        let cid=uuid::Uuid::new_v4().to_string();let coeff=fit.coefficients;let old_source=e.data["gravity_source"].clone();
        let calibration=Entity{id:cid.clone(),kind:"calibrations".into(),name:format!("{} · iSpindel {}",e.name,chrono::Utc::now().format("%Y-%m-%d %H:%M")),data:json!({"sensor":id,"kind":"ispindel","enabled":true,"unit":"SG","constant_term":coeff[0],"first_degree_coefficient":coeff[1],"second_degree_coefficient":coeff[2],"third_degree_coefficient":coeff[3],"fit":fit,"points":points,"previous_active_id":previous,"previous_source":old_source})};
        db::put(&tx,&calibration)?;e.data["active_ispindel_calibration"]=json!(cid);e.data["gravity_source"]=json!("server");db::put(&tx,&e)?;
        tx.execute("INSERT INTO audit VALUES(?,?,?)",rusqlite::params![chrono::Utc::now().timestamp(),"ispindel_calibration_apply",json!({"sensor":id,"previous":previous,"active":cid,"previous_source":old_source}).to_string()])?;tx.commit()?;Ok(Some(cid))
    }).await?;
    match result {
        Some(id) => Ok(Json(
            json!({"applied":true,"id":id,"future_readings_only":true}),
        )),
        None => Err(ApiError(
            StatusCode::CONFLICT,
            "References or active calibration changed. Preview the fit again.".into(),
        )),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Restore {
    pub expected_active_id: String,
    pub confirm: bool,
}
pub async fn restore(
    State(a): State<App>,
    Path(id): Path<String>,
    Json(v): Json<Restore>,
) -> Result<Json<Value>, ApiError> {
    if !v.confirm {
        return Err(ApiError::bad("Confirm restoration"));
    }
    let restored =
        a.db.run(move |c| {
            let tx = c.transaction()?;
            let mut e = sensor(&tx, &id)?;
            if e.data["active_ispindel_calibration"].as_str() != Some(v.expected_active_id.as_str())
            {
                return Ok(false);
            }
            let mut current = db::get(&tx, &v.expected_active_id)?;
            anyhow::ensure!(
                current.kind == "calibrations" && current.data["sensor"] == id,
                "Calibration belongs to another sensor"
            );
            let previous = current.data["previous_active_id"].clone();
            current.data["enabled"] = json!(false);
            db::put(&tx, &current)?;
            if let Some(old) = previous.as_str() {
                let mut old = db::get(&tx, old)?;
                anyhow::ensure!(
                    old.data["sensor"] == id,
                    "Calibration belongs to another sensor"
                );
                old.data["enabled"] = json!(true);
                db::put(&tx, &old)?;
            }
            e.data["active_ispindel_calibration"] = previous.clone();
            e.data["gravity_source"] = current.data["previous_source"]
                .as_str()
                .unwrap_or("server")
                .into();
            db::put(&tx, &e)?;
            tx.execute(
                "INSERT INTO audit VALUES(?,?,?)",
                rusqlite::params![
                    chrono::Utc::now().timestamp(),
                    "ispindel_calibration_restore",
                    json!({"sensor":id,"from":v.expected_active_id,"to":previous}).to_string()
                ],
            )?;
            tx.commit()?;
            Ok(true)
        })
        .await?;
    if !restored {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Active calibration changed. Reload the page.".into(),
        ));
    }
    Ok(Json(json!({"restored":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn refs(c: [f64; 4]) -> Vec<Reference> {
        [15., 25., 35., 45., 55., 65., 75.]
            .iter()
            .enumerate()
            .map(|(i, &x)| Reference {
                id: i.to_string(),
                time: i as i64,
                angle: x,
                gravity: evaluate(&c, x),
                reported_gravity: None,
                reported_unit: "unknown".into(),
            })
            .collect()
    }
    #[test]
    fn fits_quadratic_and_cubic_with_residuals() {
        for (degree, c) in [
            (2, [0.98, 0.0001, 0.00002, 0.]),
            (3, [0.98, 0.0001, 0.000002, 0.0000002]),
        ] {
            let points = refs(c);
            let model = fit(&points, degree).unwrap();
            assert!(model.rmse < 1e-12);
            assert!(model.max_error < 1e-12);
            for (a, b) in model.coefficients.iter().zip(c) {
                assert!((a - b).abs() < 1e-11);
            }
            assert_eq!(model.residuals.len(), points.len());
            assert!(model.formula.contains("tilt^2"));
            let mut noisy = points;
            noisy[3].gravity += 0.002;
            assert!(fit(&noisy, degree).unwrap().rmse > 0.0001);
        }
    }
    #[test]
    fn rejects_insufficient_degenerate_and_invalid_references() {
        let mut points = refs([1., 0.001, 0., 0.]);
        assert!(fit(&points[..2], 2).is_err());
        assert!(fit(&points, 4).is_err());
        for p in &mut points {
            p.angle = 20.;
        }
        assert!(fit(&points, 2).is_err());
        for (i, p) in points.iter_mut().enumerate() {
            p.angle = if i % 2 == 0 { 20. } else { 50. };
        }
        assert!(fit(&points, 2).is_err());
        points[0].angle = f64::NAN;
        assert!(fit(&points, 2).is_err());
    }
    #[tokio::test]
    async fn preview_apply_restore_are_revision_checked_and_preserve_history() {
        use std::{
            collections::HashMap,
            sync::{Arc, Mutex},
        };
        let dir = tempfile::tempdir().unwrap();
        let db = db::Db::init(dir.path().join("cal.sqlite")).unwrap();
        let mut e = Entity {
            id: "s".into(),
            kind: "sensors".into(),
            name: "Test".into(),
            data: json!({"sensor_type":"ispindel","gravity_source":"device","reported_gravity_unit":"SG","constant_term":1.0}),
        };
        let conn = db.open().unwrap();
        db::put(&conn, &e).unwrap();
        for p in refs([0.98, 0.0001, 0.00002, 0.]) {
            db::point(&conn,&db::Point{source:"s".into(),time:p.time,sequence:0,values:json!({"reading_source":"manual","calibration_reference":true,"angle":p.angle,"reference_gravity":p.gravity,"gravity":p.gravity})}).unwrap();
        }
        let a = App {
            db: db.clone(),
            secure_cookie: false,
            proxy_proof: None,
            import_root: Arc::new(dir.path().into()),
            control: false,
            collection: false,
            exports: false,
            failures: Arc::new(Mutex::new(HashMap::new())),
        };
        let selection = || Selection {
            degree: 2,
            points: None,
            expected_revision: None,
            confirm_apply: true,
        };
        let (_, rev, _) = preview_value(&conn, "s", &selection()).unwrap();
        e.data["reported_gravity_unit"] = json!("Plato");
        db::put(&conn, &e).unwrap();
        let mut stale = selection();
        stale.expected_revision = Some(rev);
        let err = apply(State(a.clone()), Path("s".into()), Json(stale))
            .await
            .err()
            .unwrap();
        assert_eq!(err.0, StatusCode::CONFLICT);
        let (_, revision, _) = preview_value(&conn, "s", &selection()).unwrap();
        let mut v = selection();
        v.expected_revision = Some(revision);
        let result = apply(State(a.clone()), Path("s".into()), Json(v))
            .await
            .ok()
            .unwrap()
            .0;
        let current = db::get(&conn, "s").unwrap();
        assert_eq!(current.data["gravity_source"], "server");
        let packet = json!({"angle":50,"temperature":20,"gravity":12.});
        let values = crate::sensors::ispindel_values(
            &packet,
            &current,
            &db::list(&conn, "calibrations").unwrap(),
        )
        .unwrap();
        assert_eq!(values["gravity"], 1.035);
        assert_eq!(values["ispindel_gravity"], 12.);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM points", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            7
        );
        let id = result["id"].as_str().unwrap().to_owned();
        assert!(
            restore(
                State(a.clone()),
                Path("s".into()),
                Json(Restore {
                    expected_active_id: "wrong".into(),
                    confirm: true
                })
            )
            .await
            .is_err()
        );
        assert!(
            restore(
                State(a),
                Path("s".into()),
                Json(Restore {
                    expected_active_id: id,
                    confirm: true
                })
            )
            .await
            .is_ok()
        );
        let restored = db::get(&conn, "s").unwrap();
        assert!(restored.data["active_ispindel_calibration"].is_null());
        assert_eq!(restored.data["gravity_source"], "device");
        assert_eq!(
            db::list(&conn, "calibrations").unwrap()[0].data["enabled"],
            false
        );
        assert_eq!(references(&conn, "s").unwrap().len(), 7);
    }
}

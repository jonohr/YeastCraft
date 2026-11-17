// SPDX-License-Identifier: GPL-3.0-only
mod calibration;
use anyhow::{Context, Result, bail, ensure};
use calibration::{Polynomial, Reference};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{env, fs, time::Duration};

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Point {
    hours: f64,
    angle: f64,
    gravity: f64,
    temperature: f64,
}
fn validate(points: &[Point]) -> Result<()> {
    ensure!(
        !points.is_empty(),
        "Scenario must contain at least one point"
    );
    ensure!(points[0].hours == 0., "First point must start at hour 0");
    for (i, p) in points.iter().enumerate() {
        ensure!(
            p.hours.is_finite() && p.hours >= 0. && (i == 0 || p.hours > points[i - 1].hours),
            "Times must be finite and strictly increasing"
        );
        ensure!(
            p.angle.is_finite() && (0. ..=180.).contains(&p.angle),
            "Angle must be 0..180 degrees"
        );
        ensure!(
            p.gravity.is_finite() && (0.5..=2.).contains(&p.gravity),
            "Gravity must be 0.5..2 SG"
        );
        ensure!(
            p.temperature.is_finite() && (-55. ..=125.).contains(&p.temperature),
            "Temperature must be -55..125 C"
        );
    }
    Ok(())
}
fn sample(points: &[Point], hours: f64) -> Point {
    for pair in points.windows(2) {
        let (a, b) = (&pair[0], &pair[1]);
        if hours < b.hours {
            let f = ((hours - a.hours) / (b.hours - a.hours)).clamp(0., 1.);
            return Point {
                hours,
                angle: a.angle + (b.angle - a.angle) * f,
                gravity: a.gravity + (b.gravity - a.gravity) * f,
                temperature: a.temperature + (b.temperature - a.temperature) * f,
            };
        }
    }
    points.last().unwrap().clone()
}
fn packet(p: &Point, name: &str, interval: f64, token: &str) -> Value {
    json!({"name":name,"ID":900001,"token":token,"angle":p.angle,"temperature":p.temperature,"temp_units":"C","battery":4.1,"gravity":p.gravity,"gravity_units":"SG","interval":interval,"RSSI":-55})
}
#[tokio::main]
async fn main() -> Result<()> {
    let mut args = env::args().skip(1);
    let (mut url, mut scenario, mut token_file) = (None, None, None);
    let (mut model_path, mut calibration_path, mut fit_path, mut output_path) =
        (None, None, None, None);
    let mut degree = 2usize;
    let mut explicit_angle = false;
    let mut name = "iSpindel Emulator".to_string();
    let (mut interval, mut speed, mut count) = (30_f64, 1_f64, 1_u64);
    let mut fixed = Point {
        hours: 0.,
        angle: 45.,
        gravity: 1.050,
        temperature: 20.,
    };
    while let Some(arg) = args.next() {
        if arg == "--help" || arg == "-h" {
            println!(
                "Calibration: --model FILE --calibration FILE derives angle from true SG, then reports calibrated SG.\nFit: --fit REFERENCES.json --degree 2 --output CALIBRATION.json (no sending).\nCoefficients are [constant, linear, quadratic, cubic].\n\niSpindel Emulator\nWithout --url: preview JSON only (no network).\n\n--url URL          Exact HTTP(S) ingest URL, e.g. http://localhost:8316/iSpindel\n--token-file PATH  Token file (or ISPINDEL_TOKEN environment variable)\n--name NAME        Sensor name (default: iSpindel Emulator)\n--scenario PATH    JSON keyframes: hours, angle, gravity (SG), temperature (C)\n--angle N          Fixed tilt angle (default 45)\n--gravity N        Fixed SG (default 1.050)\n--temperature N    Fixed Celsius temperature (default 20)\n--interval N       Real seconds between samples (default 30, minimum 0.1)\n--speed N          Simulated time multiplier (default 1)\n--count N          Samples (default 1; 0 runs until Ctrl+C)\n\nScenarios interpolate linearly and hold their final value. First sample is hour 0.\nNo automatic retries; failed requests stop with a nonzero exit code. Tokens are never logged."
            );
            return Ok(());
        }
        let value = args
            .next()
            .with_context(|| format!("Missing value for {arg}"))?;
        match arg.as_str() {
            "--model" => model_path = Some(value),
            "--calibration" => calibration_path = Some(value),
            "--fit" => fit_path = Some(value),
            "--output" => output_path = Some(value),
            "--degree" => degree = value.parse()?,
            "--url" => url = Some(value),
            "--scenario" => scenario = Some(value),
            "--token-file" => token_file = Some(value),
            "--name" => name = value,
            "--interval" => interval = value.parse()?,
            "--speed" => speed = value.parse()?,
            "--count" => count = value.parse()?,
            "--angle" => {
                fixed.angle = value.parse()?;
                explicit_angle = true;
            }
            "--gravity" => fixed.gravity = value.parse()?,
            "--temperature" => fixed.temperature = value.parse()?,
            _ => bail!("Unknown option: {arg}"),
        }
    }
    if let Some(path) = fit_path {
        ensure!(
            url.is_none() && model_path.is_none() && calibration_path.is_none(),
            "Fit mode cannot send or simulate"
        );
        let rows: Vec<Reference> = serde_json::from_str(&fs::read_to_string(path)?)?;
        let fitted = calibration::fit(&rows, degree)?;
        let rmse = (rows
            .iter()
            .map(|r| (fitted.sg(r.angle) - r.sg).powi(2))
            .sum::<f64>()
            / rows.len() as f64)
            .sqrt();
        let text = serde_json::to_string_pretty(&fitted)?;
        if let Some(path) = output_path {
            fs::write(path, text + "\n")?;
        } else {
            println!("{text}");
        }
        eprintln!(
            "Fitted {} references; RMSE={rmse:.8} SG (on reference points)",
            rows.len()
        );
        return Ok(());
    }
    ensure!(output_path.is_none(), "--output requires --fit");
    ensure!(
        model_path.is_some() == calibration_path.is_some(),
        "Use --model and --calibration together"
    );
    ensure!(
        !explicit_angle || model_path.is_none(),
        "--angle cannot override a modeled sensor; set true --gravity instead"
    );
    let model: Option<Polynomial> = model_path
        .map(|path| -> Result<_> {
            let p: Polynomial = serde_json::from_str(&fs::read_to_string(path)?)?;
            p.validate()?;
            Ok(p)
        })
        .transpose()?;
    let calibration: Option<Polynomial> = calibration_path
        .map(|path| -> Result<_> {
            let p: Polynomial = serde_json::from_str(&fs::read_to_string(path)?)?;
            p.validate()?;
            Ok(p)
        })
        .transpose()?;
    ensure!(
        interval.is_finite() && (0.1..=86400.).contains(&interval),
        "Interval must be 0.1..86400 seconds"
    );
    ensure!(
        speed.is_finite() && speed > 0.,
        "Speed must be finite and positive"
    );
    ensure!(speed * interval < f64::MAX / 1e20, "Speed too large");
    ensure!(!name.trim().is_empty(), "Name cannot be empty");
    let points: Vec<Point> = match scenario {
        Some(path) => serde_json::from_str(&fs::read_to_string(path)?)?,
        None => vec![fixed],
    };
    validate(&points)?;
    // Validate the full modeled curve before sending any packets.
    if let (Some(model), Some(calibration)) = (&model, &calibration) {
        for p in &points {
            model.angle(p.gravity)?;
        }
        for i in 0..=1800 {
            let sg = calibration.sg(i as f64 / 10.);
            ensure!(sg.is_finite(), "Calibration overflows in the angle range");
        }
    }
    let token = if let Some(path) = token_file {
        fs::read_to_string(path)?.trim().to_owned()
    } else {
        env::var("ISPINDEL_TOKEN").unwrap_or_default()
    };
    if url.is_some() {
        ensure!(
            !token.is_empty(),
            "Sending requires --token-file or ISPINDEL_TOKEN"
        );
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()?;
    if let Some(ref u) = url {
        let u = reqwest::Url::parse(u)?;
        ensure!(
            matches!(u.scheme(), "http" | "https")
                && u.host_str().is_some()
                && u.username().is_empty()
                && u.password().is_none()
                && u.query().is_none()
                && u.fragment().is_none(),
            "Use a plain HTTP(S) endpoint without credentials, query or fragment"
        );
    }
    let mut n = 0u64;
    loop {
        let hours = n as f64 * interval * speed / 3600.;
        let mut p = sample(&points, hours);
        if let (Some(model), Some(calibration)) = (&model, &calibration) {
            p.angle = model.angle(p.gravity)?;
            p.gravity = calibration.sg(p.angle);
            ensure!(
                p.gravity.is_finite() && (0.5..=2.).contains(&p.gravity),
                "Calibrated SG outside 0.5..2; fix the calibration"
            );
        }
        let payload = packet(&p, &name, interval, &token);
        if let Some(ref url) = url {
            // Do not log response bodies or URLs: upstream errors may echo secrets.
            let response =
                client.post(url).json(&payload).send().await.map_err(|_| {
                    anyhow::anyhow!("HTTP send failed; check endpoint/connectivity")
                })?;
            ensure!(
                response.status().is_success(),
                "Receiver returned HTTP {} (no retry)",
                response.status().as_u16()
            );
            println!(
                "sent sample={} simulated_hours={hours:.4} angle={:.3} SG={:.5} temperature={:.2}C",
                n + 1,
                p.angle,
                p.gravity,
                p.temperature
            );
        } else {
            let mut redacted = payload;
            redacted["token"] = json!("<redacted>");
            println!("{redacted}");
        }
        n += 1;
        if count > 0 && n >= count {
            break;
        }
        tokio::select! { _=tokio::time::sleep(Duration::from_secs_f64(interval))=>{}, result=tokio::signal::ctrl_c()=>{result?; break;} }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interpolates_and_holds_final_values() {
        let points = vec![
            Point {
                hours: 0.,
                angle: 60.,
                gravity: 1.06,
                temperature: 18.,
            },
            Point {
                hours: 24.,
                angle: 30.,
                gravity: 1.01,
                temperature: 20.,
            },
        ];
        validate(&points).unwrap();
        let p = sample(&points, 12.);
        assert_eq!(p.angle, 45.);
        assert!((p.gravity - 1.035).abs() < 1e-10);
        assert_eq!(p.temperature, 19.);
        assert_eq!(sample(&points, 100.).gravity, 1.01);
        let v = packet(&p, "Test", 30., "secret");
        assert_eq!(v["gravity_units"], "SG");
        assert_eq!(v["temp_units"], "C");
        assert_eq!(v["token"], "secret");
    }
    #[test]
    fn rejects_bad_scenarios() {
        for text in [
            "[]",
            r#"[{"hours":1,"angle":45,"gravity":1.05,"temperature":20}]"#,
            r#"[{"hours":0,"angle":181,"gravity":1.05,"temperature":20}]"#,
            r#"[{"hours":0,"angle":45,"gravity":1.05,"temperature":20},{"hours":0,"angle":44,"gravity":1.04,"temperature":20}]"#,
        ] {
            let p: Vec<Point> = serde_json::from_str(text).unwrap();
            assert!(validate(&p).is_err());
        }
    }
}

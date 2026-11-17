// SPDX-License-Identifier: GPL-3.0-only
use crate::sensors::convert;
use anyhow::{Context, Result};
use serde_json::Value;
pub fn target(data: &Value, hours: f64, unit: &str) -> Result<f64> {
    if let Some(legacy) = data["legacy_steps"].as_array().filter(|s| {
        !s.is_empty()
            && data["steps"]
                .as_array()
                .is_none_or(|steps| steps.is_empty())
    }) {
        let mut pts = legacy
            .iter()
            .map(|p| {
                let t = p["temperature_setting"]
                    .as_f64()
                    .or_else(|| {
                        p["temperature_setting"]
                            .as_str()
                            .and_then(|x| x.parse().ok())
                    })
                    .context("Invalid profile temperature")?;
                let time =
                    p["ttl"].as_f64().context("Unsupported legacy duration")? / 3_600_000_000.0;
                Ok((
                    time,
                    convert(t, p["temp_format"].as_str().unwrap_or("C"), unit)?,
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        pts.sort_by(|a, b| a.0.total_cmp(&b.0));
        if hours <= pts[0].0 {
            return Ok(pts[0].1);
        }
        for pair in pts.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            if hours < b.0 {
                return Ok(
                    ((a.1 + (b.1 - a.1) * (hours - a.0) / (b.0 - a.0)) * 10.0).round() / 10.0,
                );
            }
        }
        return Ok(pts.last().unwrap().1);
    }
    let steps = data["steps"]
        .as_array()
        .filter(|s| !s.is_empty())
        .context("Profile has no steps")?;
    let mut elapsed = 0.0;
    let mut previous = None;
    for s in steps {
        let duration = s["hours"].as_f64().context("Missing duration")?;
        anyhow::ensure!(duration > 0.0, "Duration must be positive");
        let temp = convert(
            s["temperature"].as_f64().context("Missing temperature")?,
            data["unit"].as_str().unwrap_or("C"),
            unit,
        )?;
        if hours < elapsed + duration {
            return Ok(if s["transition"] == "ramp" {
                let from = previous.unwrap_or(temp);
                ((from + (temp - from) * ((hours - elapsed) / duration).clamp(0.0, 1.0)) * 10.0)
                    .round()
                    / 10.0
            } else {
                temp
            });
        }
        elapsed += duration;
        previous = Some(temp);
    }
    Ok(previous.unwrap())
}
pub fn elapsed_since(start: i64, now: i64) -> Option<f64> {
    (now >= start).then(|| now.saturating_sub(start) as f64 / 3_600_000.0)
}
pub fn completion_off(data: &Value, hours: f64) -> bool {
    data["end_behavior"] == "off"
        && data["steps"].as_array().is_some_and(|s| {
            !s.is_empty()
                && hours
                    >= s.iter()
                        .map(|v| v["hours"].as_f64().unwrap_or(f64::INFINITY))
                        .sum::<f64>()
        })
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn legacy_first_hold_ramp_and_end() {
        let p = json!({"legacy_steps":[{"ttl":0,"temperature_setting":"18.0","temp_format":"C"},{"ttl":7200000000_i64,"temperature_setting":"20.0","temp_format":"C"}]});
        assert_eq!(target(&p, 0.0, "C").unwrap(), 18.0);
        assert_eq!(target(&p, 1.0, "C").unwrap(), 19.0);
        assert_eq!(target(&p, 10.0, "C").unwrap(), 20.0);
        assert_eq!(target(&p, 0.0, "F").unwrap(), 64.4);
    }
    #[test]
    fn scheduled_profile_waits_and_resumes_from_persisted_time() {
        assert_eq!(elapsed_since(1000, 999), None);
        assert_eq!(elapsed_since(1000, 1000), Some(0.0));
        assert_eq!(elapsed_since(1000, 3_601_000), Some(1.0));
    }
    #[test]
    fn completion_is_explicit_and_boundary_checked() {
        let p = json!({"end_behavior":"off","steps":[{"hours":24}]});
        assert!(!completion_off(&p, 23.99));
        assert!(completion_off(&p, 24.0));
        assert!(!completion_off(&json!({"steps":[{"hours":24}]}), 30.0));
        assert!(!completion_off(
            &json!({"end_behavior":"off","steps":[]}),
            30.0
        ));
    }
    #[test]
    fn new_holds_and_ramps() {
        let p = json!({"unit":"C","steps":[{"hours":24,"temperature":18,"transition":"hold"},{"hours":2,"temperature":20,"transition":"ramp"}]});
        assert_eq!(target(&p, 12.0, "C").unwrap(), 18.0);
        assert_eq!(target(&p, 25.0, "C").unwrap(), 19.0);
        assert_eq!(target(&p, 40.0, "C").unwrap(), 20.0);
    }
}

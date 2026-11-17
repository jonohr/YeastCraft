// SPDX-License-Identifier: GPL-3.0-only
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

/// Coefficients in ascending order: d + c*angle + b*angle² + a*angle³.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Polynomial {
    pub coefficients: Vec<f64>,
}
impl Polynomial {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            (1..=4).contains(&self.coefficients.len())
                && self.coefficients.iter().all(|v| v.is_finite()),
            "Use 1..4 finite coefficients in ascending order"
        );
        Ok(())
    }
    pub fn sg(&self, angle: f64) -> f64 {
        self.coefficients
            .iter()
            .rev()
            .fold(0., |v, c| v * angle + c)
    }
    pub fn angle(&self, sg: f64) -> Result<f64> {
        self.validate()?;
        // Require a strictly increasing model throughout the physical angle range.
        let c = |i| *self.coefficients.get(i).unwrap_or(&0.);
        let derivative = |x: f64| c(1) + 2. * c(2) * x + 3. * c(3) * x * x;
        let mut checks = vec![derivative(0.), derivative(180.)];
        if c(3) != 0. {
            let vertex = -c(2) / (3. * c(3));
            if (0. ..180.).contains(&vertex) {
                checks.push(derivative(vertex));
            }
        }
        ensure!(
            checks.iter().all(|d| *d > 0.),
            "Sensor model must be strictly increasing on 0..180 degrees"
        );
        ensure!(
            sg.is_finite() && sg >= self.sg(0.) && sg <= self.sg(180.),
            "True SG is outside the sensor model's range"
        );
        let (mut lo, mut hi) = (0., 180.);
        for _ in 0..64 {
            let mid = (lo + hi) / 2.;
            if self.sg(mid) < sg {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        Ok((lo + hi) / 2.)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reference {
    pub angle: f64,
    pub sg: f64,
}

/// Least squares on centered/scaled angles; pivoted elimination (degree at most 3).
pub fn fit(rows: &[Reference], degree: usize) -> Result<Polynomial> {
    ensure!(
        (1..=3).contains(&degree) && rows.len() > degree,
        "Degree 1..3 requires at least degree+1 reference points"
    );
    ensure!(
        rows.iter().all(|r| r.angle.is_finite()
            && (0. ..=180.).contains(&r.angle)
            && r.sg.is_finite()
            && (0.5..=2.).contains(&r.sg)),
        "Invalid calibration reference"
    );
    let min = rows.iter().map(|r| r.angle).fold(f64::INFINITY, f64::min);
    let max = rows
        .iter()
        .map(|r| r.angle)
        .fold(f64::NEG_INFINITY, f64::max);
    let center = (max + min) / 2.;
    let scale = (max - min) / 2.;
    ensure!(scale > 1e-6, "Reference angles must span a range");
    let n = degree + 1;
    let mut a = vec![vec![0.; n + 1]; n];
    for r in rows {
        let x = (r.angle - center) / scale;
        for (i, row) in a.iter_mut().enumerate() {
            for (j, v) in row.iter_mut().enumerate().take(n) {
                *v += x.powi((i + j) as i32);
            }
            row[n] += r.sg * x.powi(i as i32);
        }
    }
    for i in 0..n {
        let pivot = (i..n)
            .max_by(|&x, &y| a[x][i].abs().total_cmp(&a[y][i].abs()))
            .unwrap();
        a.swap(i, pivot);
        ensure!(
            a[i][i].abs() > 1e-10,
            "Reference angles do not support this polynomial degree"
        );
        let d = a[i][i];
        for v in &mut a[i][i..=n] {
            *v /= d;
        }
        let pivot_row = a[i].clone();
        for (k, row) in a.iter_mut().enumerate() {
            if k != i {
                let f = row[i];
                for (v, pivot) in row[i..=n].iter_mut().zip(&pivot_row[i..=n]) {
                    *v -= f * pivot;
                }
            }
        }
    }
    // Expand ((angle-center)/scale)^i into original angle coordinates.
    let mut coefficients = vec![0.; n];
    for (i, row) in a.iter().enumerate() {
        let mut basis = vec![1.];
        for _ in 0..i {
            let mut next = vec![0.; basis.len() + 1];
            for (j, b) in basis.iter().enumerate() {
                next[j] += -center / scale * b;
                next[j + 1] += b / scale;
            }
            basis = next;
        }
        for (j, b) in basis.iter().enumerate() {
            coefficients[j] += row[n] * b;
        }
    }
    let p = Polynomial { coefficients };
    p.validate()?;
    Ok(p)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn calibrating_changes_report_not_angle() {
        let truth = Polynomial {
            coefficients: vec![0.98, 0.001, 0.000005],
        };
        let refs: Vec<_> = [20., 40., 60., 80., 100.]
            .iter()
            .map(|&angle| Reference {
                angle,
                sg: truth.sg(angle),
            })
            .collect();
        let fitted = fit(&refs, 2).unwrap();
        let angle = truth.angle(1.05).unwrap();
        assert!((fitted.sg(angle) - 1.05).abs() < 1e-10);
        let bad = Polynomial {
            coefficients: vec![1.02, 0.001],
        };
        assert!((bad.sg(angle) - 1.05).abs() > 0.005);
        assert!((truth.angle(1.05).unwrap() - angle).abs() < 1e-12);
        assert!(truth.angle(2.).is_err());
        assert!(
            fit(
                &[
                    Reference {
                        angle: 40.,
                        sg: 1.04
                    },
                    Reference {
                        angle: 40.,
                        sg: 1.04
                    }
                ],
                1
            )
            .is_err()
        );
    }
}

//! Compare against goldens produced by upstream rwkv-srs v0.1.1 (rwkv/golden/).

use rcfc_rwkv::{ReviewInput, Runtime};
use serde_json::Value;

const MODEL: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../models/RWKV_trained_on_101_4999.safetensors");
const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../golden/v1_101_4999.json");
/// Probability tolerance. Upstream and we both run f32, but summation order differs.
const P_TOL: f64 = 1e-6;

fn input(v: &Value) -> ReviewInput {
    let id = |k: &str| v[k].as_i64();
    ReviewInput {
        card_id: v["card_id"].as_i64().unwrap(),
        note_id: id("note_id"),
        deck_id: id("deck_id"),
        preset_id: id("preset_id"),
        day_offset: v["day_offset"].as_f64().unwrap(),
        elapsed_days: v["elapsed_days"].as_f64().unwrap(),
        elapsed_seconds: v["elapsed_seconds"].as_f64().unwrap(),
        rating: v["rating"].as_i64(),
        duration: v["duration"].as_f64(),
        state: v["state"].as_f64(),
    }
}

fn floats(v: &Value) -> Vec<f32> {
    v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap() as f32).collect()
}

#[test]
fn matches_upstream_golden() {
    let model = std::fs::read(MODEL).expect("model file");
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(GOLDEN).unwrap()).unwrap();
    let mut rt = Runtime::new(&model).unwrap();
    let reviews = golden["reviews"].as_array().unwrap();
    let batches = golden["predictions"].as_array().unwrap();
    let mut next_batch = 0;
    let mut max_p_err = 0.0f64;

    for (n, r) in reviews.iter().enumerate() {
        let inp = input(&r["input"]);
        let (pf, af) = rt.debug_features(&inp).unwrap();
        let (gpf, gaf) = (floats(&r["predict_features"]), floats(&r["process_features"]));
        for (i, (a, b)) in pf.iter().zip(&gpf).enumerate() {
            assert!((a - b).abs() <= 1e-6, "review {n}: predict feature {i}: ours {a}, upstream {b}");
        }
        for (i, (a, b)) in af.iter().zip(&gaf).enumerate() {
            assert!((a - b).abs() <= 1e-6, "review {n}: process feature {i}: ours {a}, upstream {b}");
        }
        let p = rt.process(&inp).unwrap();
        let want = r["p"].as_f64().unwrap();
        max_p_err = max_p_err.max((p - want).abs());
        assert!((p - want).abs() <= P_TOL, "review {n}: p ours {p}, upstream {want}");

        while next_batch < batches.len() && batches[next_batch]["after_reviews"].as_u64().unwrap() as usize == n + 1 {
            let b = &batches[next_batch];
            let inputs: Vec<ReviewInput> = b["inputs"].as_array().unwrap().iter().map(input).collect();
            let got = rt.predict(&inputs);
            for (i, (g, w)) in got.iter().zip(b["p"].as_array().unwrap()).enumerate() {
                let w = w.as_f64().unwrap();
                max_p_err = max_p_err.max((g - w).abs());
                assert!((g - w).abs() <= P_TOL, "batch {next_batch} row {i}: ours {g}, upstream {w}");
            }
            next_batch += 1;
        }
    }
    assert_eq!(next_batch, batches.len(), "all prediction batches checked");
    eprintln!("{} reviews, {} batches, max |Δp| = {max_p_err:e}", reviews.len(), batches.len());
}

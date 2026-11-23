//! JS bindings. Rows are passed as flat Float64Arrays (fast, no JSON), ROW_WIDTH
//! numbers per row, in this order:
//!
//!   card_id, note_id, deck_id, preset_id, day_offset, elapsed_days,
//!   elapsed_seconds, rating, duration_ms, state
//!
//! Ids are integers < 2^53 (exact in f64). Use NaN for a missing note/deck/preset
//! id, and NaN for rating/duration/state in prediction rows.

use wasm_bindgen::prelude::*;

use crate::{ReviewInput, Runtime};

pub const ROW_WIDTH: usize = 10;

#[wasm_bindgen]
pub struct Rwkv {
    rt: Runtime,
}

fn id(v: f64) -> Option<i64> {
    (!v.is_nan()).then_some(v as i64)
}
fn opt(v: f64) -> Option<f64> {
    (!v.is_nan()).then_some(v)
}

fn rows(data: &[f64]) -> Result<Vec<ReviewInput>, JsError> {
    if data.len() % ROW_WIDTH != 0 {
        return Err(JsError::new(&format!("row data length {} is not a multiple of {ROW_WIDTH}", data.len())));
    }
    Ok(data
        .chunks_exact(ROW_WIDTH)
        .map(|r| ReviewInput {
            card_id: r[0] as i64,
            note_id: id(r[1]),
            deck_id: id(r[2]),
            preset_id: id(r[3]),
            day_offset: r[4],
            elapsed_days: r[5],
            elapsed_seconds: r[6],
            rating: id(r[7]),
            duration: opt(r[8]),
            state: opt(r[9]),
        })
        .collect())
}

#[wasm_bindgen]
impl Rwkv {
    /// Load a V1 model (.safetensors bytes).
    #[wasm_bindgen(constructor)]
    pub fn new(weights: &[u8]) -> Result<Rwkv, JsError> {
        Runtime::new(weights).map(|rt| Rwkv { rt }).map_err(|e| JsError::new(&e))
    }

    /// Apply answered reviews in time order. Returns, per review, the P(recall)
    /// predicted just before the answer (useful for calibration).
    pub fn process(&mut self, data: &[f64]) -> Result<Vec<f64>, JsError> {
        rows(data)?
            .iter()
            .map(|r| self.rt.process(r).map_err(|e| JsError::new(&e)))
            .collect()
    }

    /// P(recall) now for each row. Does not change state.
    pub fn predict(&mut self, data: &[f64]) -> Result<Vec<f64>, JsError> {
        Ok(self.rt.predict(&rows(data)?))
    }

    #[wasm_bindgen(getter, js_name = reviewsProcessed)]
    pub fn reviews_processed(&self) -> f64 {
        self.rt.reviews_processed() as f64
    }

    /// Numbers per row in `process` / `predict` input.
    #[wasm_bindgen(js_name = rowWidth)]
    pub fn row_width() -> usize {
        ROW_WIDTH
    }
}

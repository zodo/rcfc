//! JS bindings. Rows are passed as flat Float64Arrays (fast, no JSON), ROW_WIDTH
//! numbers per row, in this order:
//!
//!   card_id, note_id, deck_id, preset_id, day_offset, elapsed_days,
//!   elapsed_seconds, rating, duration_ms, state
//!
//! Ids are integers < 2^53 (exact in f64). Use NaN for a missing note/deck/preset
//! id, and NaN for rating/duration/state in prediction rows.

use wasm_bindgen::prelude::*;

use crate::{Kind, ReviewInput, Runtime};

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
        return Err(JsError::new(&format!(
            "row data length {} is not a multiple of {ROW_WIDTH}",
            data.len()
        )));
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
        Runtime::new(weights)
            .map(|rt| Rwkv { rt })
            .map_err(|e| JsError::new(&e))
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

    /// Like `process` without the pre-answer predictions: half the work. For replay.
    pub fn apply(&mut self, data: &[f64]) -> Result<(), JsError> {
        for r in rows(data)? {
            self.rt.apply(&r).map_err(|e| JsError::new(&e))?;
        }
        Ok(())
    }

    /// States changed since the last call, flat `[kind, id, kind, id, ...]`.
    #[wasm_bindgen(js_name = takeDirty)]
    pub fn take_dirty(&mut self) -> Vec<f64> {
        self.rt
            .take_dirty()
            .into_iter()
            .flat_map(|(k, id)| [k as u8 as f64, id as f64])
            .collect()
    }

    #[wasm_bindgen(js_name = stateBytes)]
    pub fn state_bytes(&self, kind: u8, id: f64) -> Result<Option<Vec<u8>>, JsError> {
        Ok(self.rt.state_bytes(
            Kind::from_u8(kind).map_err(|e| JsError::new(&e))?,
            id as i64,
        ))
    }

    #[wasm_bindgen(js_name = loadState)]
    pub fn load_state(&mut self, kind: u8, id: f64, bytes: &[u8]) -> Result<(), JsError> {
        let kind = Kind::from_u8(kind).map_err(|e| JsError::new(&e))?;
        self.rt
            .load_state(kind, id as i64, bytes)
            .map_err(|e| JsError::new(&e))
    }

    #[wasm_bindgen(js_name = featuresBytes)]
    pub fn features_bytes(&self) -> Vec<u8> {
        self.rt.features_bytes()
    }

    #[wasm_bindgen(js_name = loadFeatures)]
    pub fn load_features(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.rt.load_features(bytes).map_err(|e| JsError::new(&e))
    }

    /// Forget all history (keeps the model).
    pub fn reset(&mut self) {
        self.rt.reset();
    }

    #[wasm_bindgen(getter, js_name = memoryBytes)]
    pub fn memory_bytes(&self) -> f64 {
        self.rt.memory_bytes() as f64
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

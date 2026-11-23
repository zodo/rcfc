//! rcfc-rwkv: RWKV-SRS V1 (RWKV-P) inference for the browser.
//!
//! A clean reimplementation of the V1 Oracle CPU path of rwkv-srs v0.1.1
//! (zaguk/rwkv-srs), itself derived from open-spaced-repetition/srs-benchmark.
//! Checked number by number against goldens produced by upstream
//! (see rwkv/golden/). Upstream notices: rwkv/upstream/.

pub mod features;
pub mod model;
#[cfg(target_arch = "wasm32")]
mod wasm;

use std::collections::HashMap;

pub use features::ReviewInput;
use features::{FeatureState, Ids};
use model::{ModuleState, Weights, MODULES};

/// A loaded model plus everything learned from the review history so far.
pub struct Runtime {
    weights: Weights,
    features: FeatureState,
    card: HashMap<i64, ModuleState>,
    note: HashMap<i64, ModuleState>,
    deck: HashMap<i64, ModuleState>,
    preset: HashMap<i64, ModuleState>,
    global: Option<ModuleState>,
    reviews: u64,
}

impl Runtime {
    pub fn new(model_safetensors: &[u8]) -> Result<Self, String> {
        Ok(Self {
            weights: Weights::from_safetensors(model_safetensors)?,
            features: FeatureState::default(),
            card: HashMap::new(),
            note: HashMap::new(),
            deck: HashMap::new(),
            preset: HashMap::new(),
            global: None,
            reviews: 0,
        })
    }

    fn states(&self, ids: Ids) -> [Option<&ModuleState>; MODULES] {
        // Network module order: card, deck, note, preset, global.
        [self.card.get(&ids.0), self.deck.get(&ids.2), self.note.get(&ids.1), self.preset.get(&ids.3), self.global.as_ref()]
    }

    /// Apply one answered review (in time order). Returns the P(recall) the model
    /// predicted just before seeing the answer.
    pub fn process(&mut self, input: &ReviewInput) -> Result<f64, String> {
        let (query, answer, ids) = self.features.process_features(input)?;
        let (p, _) = self.weights.forward(&query, self.states(ids));
        let (_, [card, deck, note, preset, global]) = self.weights.forward(&answer, self.states(ids));
        self.card.insert(ids.0, card);
        self.note.insert(ids.1, note);
        self.deck.insert(ids.2, deck);
        self.preset.insert(ids.3, preset);
        self.global = Some(global);
        self.reviews += 1;
        Ok(p)
    }

    /// P(recall) if each card were shown now. Does not change state.
    pub fn predict(&mut self, inputs: &[ReviewInput]) -> Vec<f64> {
        inputs
            .iter()
            .map(|input| {
                let (f, ids) = self.features.predict_features(input);
                self.weights.forward(&f, self.states(ids)).0
            })
            .collect()
    }

    pub fn reviews_processed(&self) -> u64 {
        self.reviews
    }

    /// Bytes held by recurrent state (floats only; map overhead excluded).
    pub fn state_bytes(&self) -> usize {
        let size = |m: &ModuleState| m.iter().map(|l| (l.time_shift.len() + l.time_state.len() + l.channel_shift.len()) * 4).sum::<usize>();
        [&self.card, &self.note, &self.deck, &self.preset].iter().flat_map(|h| h.values()).map(size).sum::<usize>()
            + self.global.as_ref().map_or(0, size)
    }

    /// Debug/verification hooks: the feature rows a review would produce.
    pub fn debug_features(&self, input: &ReviewInput) -> Result<(Vec<f32>, Vec<f32>), String> {
        let mut probe = self.features.clone();
        let (pf, _) = probe.predict_features(input);
        let mut probe = self.features.clone();
        let (_, answer, _) = probe.process_features(input)?;
        Ok((pf, answer))
    }
}

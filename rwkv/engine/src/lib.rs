//! rcfc-rwkv: RWKV-SRS V1 (RWKV-P) inference for the browser.
//!
//! A clean reimplementation of the V1 Oracle CPU path of rwkv-srs v0.1.1
//! (zaguk/rwkv-srs), itself derived from open-spaced-repetition/srs-benchmark.
//! Checked number by number against goldens produced by upstream
//! (see rwkv/golden/). Upstream notices: rwkv/upstream/.

mod bytes;
pub mod features;
pub mod model;
#[cfg(target_arch = "wasm32")]
mod wasm;

use std::collections::{HashMap, HashSet};

use bytes::{Reader, Writer};
pub use features::ReviewInput;
use features::{FeatureState, Ids};
use model::{write_module_state, ModuleState, Weights, MODULES};

/// Recurrent-state owners, in network module order. The discriminant is the
/// module index and the checkpoint key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Card = 0,
    Deck = 1,
    Note = 2,
    Preset = 3,
    Global = 4,
}

impl Kind {
    pub fn from_u8(v: u8) -> Result<Kind, String> {
        Ok(match v {
            0 => Kind::Card,
            1 => Kind::Deck,
            2 => Kind::Note,
            3 => Kind::Preset,
            4 => Kind::Global,
            _ => return Err(format!("unknown state kind {v}")),
        })
    }
}

/// Bump when the checkpoint byte layout changes.
const FEATURES_FORMAT: u32 = 1;

/// A loaded model plus everything learned from the review history so far.
pub struct Runtime {
    weights: Weights,
    features: FeatureState,
    /// Indexed by `Kind`; Global uses key 0.
    states: [HashMap<i64, ModuleState>; MODULES],
    dirty: HashSet<(Kind, i64)>,
    reviews: u64,
}

impl Runtime {
    pub fn new(model_safetensors: &[u8]) -> Result<Self, String> {
        Ok(Self {
            weights: Weights::from_safetensors(model_safetensors)?,
            features: FeatureState::default(),
            states: Default::default(),
            dirty: HashSet::new(),
            reviews: 0,
        })
    }

    fn keys(ids: Ids) -> [i64; MODULES] {
        [ids.0, ids.2, ids.1, ids.3, 0]
    }

    fn current(&self, ids: Ids) -> [Option<&ModuleState>; MODULES] {
        let k = Self::keys(ids);
        std::array::from_fn(|m| self.states[m].get(&k[m]))
    }

    fn commit(&mut self, ids: Ids, next: [ModuleState; MODULES]) {
        let k = Self::keys(ids);
        for (m, s) in next.into_iter().enumerate() {
            self.states[m].insert(k[m], s);
            self.dirty.insert((Kind::from_u8(m as u8).unwrap(), k[m]));
        }
        self.reviews += 1;
    }

    /// Apply one answered review (in time order). Returns the P(recall) the model
    /// predicted just before seeing the answer.
    pub fn process(&mut self, input: &ReviewInput) -> Result<f64, String> {
        let (query, answer, ids) = self.features.process_features(input)?;
        let (p, _) = self.weights.forward(&query, self.current(ids));
        let (_, next) = self.weights.forward(&answer, self.current(ids));
        self.commit(ids, next);
        Ok(p)
    }

    /// Same state change as `process`, without the pre-answer prediction
    /// (half the work; for replaying history).
    pub fn apply(&mut self, input: &ReviewInput) -> Result<(), String> {
        let (_, answer, ids) = self.features.process_features(input)?;
        let (_, next) = self.weights.forward(&answer, self.current(ids));
        self.commit(ids, next);
        Ok(())
    }

    /// P(recall) if each card were shown now. Does not change state.
    pub fn predict(&mut self, inputs: &[ReviewInput]) -> Vec<f64> {
        inputs
            .iter()
            .map(|input| {
                let (f, ids) = self.features.predict_features(input);
                self.weights.forward(&f, self.current(ids)).0
            })
            .collect()
    }

    pub fn reviews_processed(&self) -> u64 {
        self.reviews
    }

    // ---- checkpoints ----
    //
    // A checkpoint is one features blob plus one blob per (kind, id) state.
    // Callers save the blobs of `take_dirty()` after `features_bytes()`, all in
    // one transaction, and restore with `load_features` + `load_state` per row.

    /// States changed since the last call.
    pub fn take_dirty(&mut self) -> Vec<(Kind, i64)> {
        let mut v: Vec<_> = self.dirty.drain().collect();
        v.sort_by_key(|(k, id)| (*k as u8, *id));
        v
    }

    pub fn state_bytes(&self, kind: Kind, id: i64) -> Option<Vec<u8>> {
        let s = self.states[kind as usize].get(&id)?;
        let mut w = Writer::default();
        write_module_state(&mut w, s);
        Some(w.0)
    }

    pub fn load_state(&mut self, kind: Kind, id: i64, bytes: &[u8]) -> Result<(), String> {
        let mut r = Reader::new(bytes);
        let s = self.weights.read_module_state(kind as usize, &mut r)?;
        r.done()?;
        self.states[kind as usize].insert(id, s);
        Ok(())
    }

    pub fn features_bytes(&self) -> Vec<u8> {
        let mut w = Writer::default();
        w.u32(FEATURES_FORMAT);
        w.u64(self.reviews);
        self.features.write(&mut w);
        w.0
    }

    pub fn load_features(&mut self, bytes: &[u8]) -> Result<(), String> {
        let mut r = Reader::new(bytes);
        let v = r.u32()?;
        if v != FEATURES_FORMAT {
            return Err(format!(
                "checkpoint format {v}, engine expects {FEATURES_FORMAT}"
            ));
        }
        let reviews = r.u64()?;
        let features = FeatureState::read(&mut r)?;
        r.done()?;
        self.reviews = reviews;
        self.features = features;
        Ok(())
    }

    /// Drop all learned state (keeps the model).
    pub fn reset(&mut self) {
        self.features = FeatureState::default();
        self.states = Default::default();
        self.dirty.clear();
        self.reviews = 0;
    }

    /// Bytes held by recurrent state (floats only; map overhead excluded).
    pub fn memory_bytes(&self) -> usize {
        let size = |m: &ModuleState| {
            m.iter()
                .map(|l| (l.time_shift.len() + l.time_state.len() + l.channel_shift.len()) * 4)
                .sum::<usize>()
        };
        self.states.iter().flat_map(|h| h.values()).map(size).sum()
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

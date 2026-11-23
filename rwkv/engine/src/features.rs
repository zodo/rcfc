//! Input features (92 per row), ported from rwkv-srs v0.1.1 `features.rs`,
//! `state.rs` and `id_encoding.rs`. Values are computed in f64 and cast to f32,
//! exactly as upstream does, so they match bit for bit.

use std::collections::{BTreeMap, BTreeSet};

pub const FEATURE_LEN: usize = 92;
const ID_PLACEHOLDER: i64 = 314_159_265_358_979_323;
const DAY_OFFSET_ENCODE_PERIODS: [f64; 7] = [3.0, 7.0, 30.0, 100.0, 365.0, 3650.0, 36500.0];
const SECONDS_PER_DAY: f64 = 86_400.0;
/// (submodule, encoding width) in feature order: card, note, deck, preset.
const ID_DIMS: [usize; 4] = [12, 12, 8, 8];

/// One review (process) or one "what is P(recall) now?" query (predict).
/// Field meanings follow the RWKV4Anki add-on: `day_offset` counts days from the
/// collection's first review day, elapsed values are -1 for a card's first review,
/// `duration` is answer time in ms, `state` is 0 new, 1 learning, 2 review, 3 relearning.
#[derive(Debug, Clone, PartialEq)]
pub struct ReviewInput {
    pub card_id: i64,
    pub note_id: Option<i64>,
    pub deck_id: Option<i64>,
    pub preset_id: Option<i64>,
    pub day_offset: f64,
    pub elapsed_days: f64,
    pub elapsed_seconds: f64,
    /// 1..=4; `None` for predictions.
    pub rating: Option<i64>,
    pub duration: Option<f64>,
    pub state: Option<f64>,
}

/// Normalized ids used to key recurrent state: (card, note, deck, preset).
pub type Ids = (i64, i64, i64, i64);

#[derive(Debug, Clone)]
pub struct FeatureState {
    first_day_offset: Option<f64>,
    prev_day_offset: Option<f64>,
    card_set: BTreeSet<i64>,
    card_count: usize,
    last_new_cards: BTreeMap<i64, usize>,
    i: i64,
    last_i: BTreeMap<i64, i64>,
    today: f64,
    today_reviews: i64,
    today_new_cards: i64,
    card2first_day_offset: BTreeMap<i64, f64>,
    card2elapsed_days_cumulative: BTreeMap<i64, f64>,
    card2elapsed_seconds_cumulative: BTreeMap<i64, f64>,
    id_encodings: [BTreeMap<i64, Vec<f32>>; 4],
    id_rng: TorchMt19937,
}

impl Default for FeatureState {
    fn default() -> Self {
        Self {
            first_day_offset: None,
            prev_day_offset: None,
            card_set: BTreeSet::new(),
            card_count: 0,
            last_new_cards: BTreeMap::new(),
            i: 0,
            last_i: BTreeMap::new(),
            today: -1.0,
            today_reviews: 0,
            today_new_cards: 0,
            card2first_day_offset: BTreeMap::new(),
            card2elapsed_days_cumulative: BTreeMap::new(),
            card2elapsed_seconds_cumulative: BTreeMap::new(),
            id_encodings: Default::default(),
            id_rng: TorchMt19937::seed_from_u64(5489),
        }
    }
}

pub fn normalized_ids(input: &ReviewInput) -> (Ids, [f64; 3]) {
    let norm = |v: Option<i64>, card: i64| match v {
        Some(id) => (id, 0.0),
        None => (ID_PLACEHOLDER + card, 1.0),
    };
    let (note, note_missing) = norm(input.note_id, input.card_id);
    let (deck, deck_missing) = norm(input.deck_id, 0);
    let (preset, preset_missing) = norm(input.preset_id, 0);
    ((input.card_id, note, deck, preset), [note_missing, deck_missing, preset_missing])
}

impl FeatureState {
    /// The 24 card features shared by query and answer rows (rating, duration,
    /// state and is_query are filled in by the caller).
    fn card_features(&self, input: &ReviewInput, missing: [f64; 3]) -> ([f32; 24], f64, f64) {
        let card = input.card_id;
        let edc = self.card2elapsed_days_cumulative.get(&card).copied().unwrap_or(0.0) + input.elapsed_days;
        let esc = self.card2elapsed_seconds_cumulative.get(&card).copied().unwrap_or(0.0) + input.elapsed_seconds;
        let day_offset = self.first_day_offset.map_or(0.0, |first| input.day_offset - first);
        let day_offset_first = self.card2first_day_offset.get(&card).copied().unwrap_or(day_offset);
        let prev = self.prev_day_offset.unwrap_or(0.0);
        let diff_new_cards = self
            .last_new_cards
            .get(&card)
            .map(|last| self.card_count as i64 - *last as i64)
            .unwrap_or(0)
            .max(0) as f64;
        let diff_reviews = self.last_i.get(&card).map(|last| (self.i - *last - 1).max(0)).unwrap_or(0) as f64;
        let (mut today_reviews, mut today_new_cards) = (self.today_reviews, self.today_new_cards);
        if day_offset != self.today {
            today_new_cards = 0;
            today_reviews = -1;
        }
        today_reviews += 1;
        if !self.card_set.contains(&card) {
            today_new_cards += 1;
        }
        let f = [
            scale_log(input.elapsed_days, 1.51, 1.62),
            scale_log(edc, 2.14, 2.25),
            scale_log(input.elapsed_seconds, 9.96, 5.21),
            day_sin(input.elapsed_seconds),
            day_cos(input.elapsed_seconds),
            scale_log(esc, 10.86, 5.8),
            day_sin(esc),
            day_cos(esc),
            0.0, // scaled_duration
            0.0, // rating_1..4
            0.0,
            0.0,
            0.0,
            missing[0],
            missing[1],
            missing[2],
            (std::f64::consts::E + (day_offset - prev)).ln().ln(),
            (py_mod(day_offset, 7.0) - 3.0) / 3.0,
            (((3.0 + diff_new_cards).ln()) - 2.945) / 2.011,
            (((3.0 + diff_reviews).ln()) - 4.64) / 2.59,
            (((3.0 + today_new_cards as f64).ln()) - 2.55) / 1.41,
            (((3.0 + today_reviews as f64).ln()) - 4.59) / 1.30,
            0.0, // scaled_state
            0.0, // is_query
        ];
        (f.map(|v| v as f32), day_offset, day_offset_first)
    }

    fn push_ids_and_days(&self, out: &mut Vec<f32>, encodings: &[Vec<f32>; 4], day_offset: f64, day_offset_first: f64) {
        for e in encodings {
            out.extend_from_slice(e);
        }
        for period in DAY_OFFSET_ENCODE_PERIODS {
            let f = 2.0 * std::f64::consts::PI / period;
            let a = py_mod(day_offset, period);
            let b = py_mod(day_offset_first, period);
            out.extend([(f * a).sin() as f32, (f * a).cos() as f32, (f * b).sin() as f32, (f * b).cos() as f32]);
        }
    }

    /// Features of a prediction query. Does not change state: an unseen id gets a
    /// provisional encoding and the RNG is rewound, as upstream does.
    pub fn predict_features(&mut self, input: &ReviewInput) -> (Vec<f32>, Ids) {
        let (ids, missing) = normalized_ids(input);
        let (mut card, day_offset, day_offset_first) = self.card_features(input, missing);
        card[23] = 1.0; // is_query
        let saved = self.id_rng.clone();
        let mut drew = false;
        let encodings = [ids.0, ids.1, ids.2, ids.3]
            .iter()
            .enumerate()
            .map(|(m, id)| match self.id_encodings[m].get(id) {
                Some(e) => e.clone(),
                None => {
                    drew = true;
                    self.id_rng.id_encoding(ID_DIMS[m])
                }
            })
            .collect::<Vec<_>>()
            .try_into()
            .unwrap();
        if drew {
            self.id_rng = saved;
        }
        let mut out = Vec::with_capacity(FEATURE_LEN);
        out.extend_from_slice(&card);
        self.push_ids_and_days(&mut out, &encodings, day_offset, day_offset_first);
        (out, ids)
    }

    /// Features of an answered review: returns (query row, answer row) and
    /// records the review. The query row yields the pre-answer prediction.
    pub fn process_features(&mut self, input: &ReviewInput) -> Result<(Vec<f32>, Vec<f32>, Ids), String> {
        let rating = input.rating.ok_or("process review is missing 'rating'")?;
        let duration = input.duration.ok_or("process review is missing 'duration'")?;
        let state = input.state.ok_or("process review is missing 'state'")?;
        if !(1..=4).contains(&rating) {
            return Err(format!("rating must be 1..=4, got {rating}"));
        }
        let (ids, missing) = normalized_ids(input);
        let (mut card, day_offset, day_offset_first) = self.card_features(input, missing);
        for (m, id) in [ids.0, ids.1, ids.2, ids.3].iter().enumerate() {
            if !self.id_encodings[m].contains_key(id) {
                let e = self.id_rng.id_encoding(ID_DIMS[m]);
                self.id_encodings[m].insert(*id, e);
            }
        }
        let encodings: [Vec<f32>; 4] = [
            self.id_encodings[0][&ids.0].clone(),
            self.id_encodings[1][&ids.1].clone(),
            self.id_encodings[2][&ids.2].clone(),
            self.id_encodings[3][&ids.3].clone(),
        ];
        let mut query = Vec::with_capacity(FEATURE_LEN);
        card[23] = 1.0;
        query.extend_from_slice(&card);
        self.push_ids_and_days(&mut query, &encodings, day_offset, day_offset_first);

        card[8] = (((10.0 + duration).ln() - 8.9) / 1.07) as f32;
        for r in 1..=4 {
            card[8 + r as usize] = if rating == r { 1.0 } else { 0.0 };
        }
        card[22] = (state - 2.0) as f32;
        card[23] = 0.0;
        let mut answer = Vec::with_capacity(FEATURE_LEN);
        answer.extend_from_slice(&card);
        self.push_ids_and_days(&mut answer, &encodings, day_offset, day_offset_first);

        self.record(input.card_id, input.elapsed_days, input.elapsed_seconds, day_offset);
        Ok((query, answer, ids))
    }

    fn record(&mut self, card: i64, elapsed_days: f64, elapsed_seconds: f64, day_offset: f64) {
        *self.card2elapsed_days_cumulative.entry(card).or_insert(0.0) += elapsed_days;
        *self.card2elapsed_seconds_cumulative.entry(card).or_insert(0.0) += elapsed_seconds;
        if self.first_day_offset.is_none() {
            self.first_day_offset = Some(day_offset);
        }
        if day_offset != self.today {
            self.today = day_offset;
            self.today_new_cards = 0;
            self.today_reviews = -1;
        }
        self.today_reviews += 1;
        if self.card_set.insert(card) {
            self.today_new_cards += 1;
            self.card_count += 1;
            self.card2first_day_offset.insert(card, day_offset - self.first_day_offset.unwrap());
        }
        self.prev_day_offset = Some(day_offset);
        self.last_i.insert(card, self.i);
        self.last_new_cards.insert(card, self.card_count);
        self.i += 1;
    }
}

fn scale_log(x: f64, mean: f64, std: f64) -> f64 {
    let l = if x == -1.0 { 0.0 } else { (1.0 + 1e-5 + x).ln() };
    (l - mean) / std
}
fn day_sin(x: f64) -> f64 {
    (py_mod(x, SECONDS_PER_DAY) * 2.0 * std::f64::consts::PI / SECONDS_PER_DAY).sin()
}
fn day_cos(x: f64) -> f64 {
    (py_mod(x, SECONDS_PER_DAY) * 2.0 * std::f64::consts::PI / SECONDS_PER_DAY).cos()
}
fn py_mod(value: f64, modulus: f64) -> f64 {
    ((value % modulus) + modulus) % modulus
}

/// MT19937 matching torch's CPU generator, used for random id encodings.
#[derive(Debug, Clone)]
struct TorchMt19937 {
    left: usize,
    next: usize,
    state: [u32; 624],
}

impl TorchMt19937 {
    fn seed_from_u64(seed: u64) -> Self {
        let mut state = [0u32; 624];
        state[0] = (seed & 0xffff_ffff) as u32;
        for j in 1..624 {
            state[j] = 1_812_433_253u32.wrapping_mul(state[j - 1] ^ (state[j - 1] >> 30)).wrapping_add(j as u32);
        }
        Self { left: 1, next: 0, state }
    }

    fn random_u32(&mut self) -> u32 {
        self.left -= 1;
        if self.left == 0 {
            self.next_state();
        }
        let mut y = self.state[self.next];
        self.next += 1;
        y ^= y >> 11;
        y ^= (y << 7) & 0x9d2c_5680;
        y ^= (y << 15) & 0xefc6_0000;
        y ^= y >> 18;
        y
    }

    fn id_encoding(&mut self, dim: usize) -> Vec<f32> {
        (0..dim).map(|_| (self.random_u32() % 4) as f32 - 1.5).collect()
    }

    fn next_state(&mut self) {
        const N: usize = 624;
        const M: usize = 397;
        let twist = |u: u32, v: u32| (((u & 0x8000_0000) | (v & 0x7fff_ffff)) >> 1) ^ if v & 1 != 0 { 0x9908_b0df } else { 0 };
        self.left = N;
        self.next = 0;
        for i in 0..(N - M) {
            self.state[i] = self.state[i + M] ^ twist(self.state[i], self.state[i + 1]);
        }
        for i in (N - M)..(N - 1) {
            self.state[i] = self.state[i + M - N] ^ twist(self.state[i], self.state[i + 1]);
        }
        self.state[N - 1] = self.state[M - 1] ^ twist(self.state[N - 1], self.state[0]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mt19937_matches_upstream_vector() {
        // Same vector as upstream id_encoding.rs test.
        let mut rng = TorchMt19937::seed_from_u64(12_345);
        assert_eq!(rng.id_encoding(12), vec![0.5, -0.5, -0.5, -0.5, -1.5, -0.5, 0.5, 0.5, -0.5, 0.5, -0.5, -0.5]);
    }
}

// rcfc golden dumper (test-only addition to upstream rwkv-srs v0.1.1).
//
// Drives the upstream V1 Oracle CPU path over a deterministic synthetic review
// history and writes inputs, per-review feature vectors and probabilities to
// JSON, so the rcfc reimplementation can be checked number by number.
//
//   GOLDEN_OUT=/path/golden.json cargo test --release --locked golden_dump -- --nocapture

use std::path::Path;

use serde_json::{json, Value};

use super::runtime::{predict_review_inputs_cpu, process_review_inputs_with_state};
use super::NativeRnn;
use crate::state::{FeatureState, MaybeId, ReviewInput};

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

struct Card {
    id: i64,
    note: i64,
    deck: i64,
    last: Option<(f64, i64)>, // (day_offset, review_id ms)
}

fn input_json(r: &ReviewInput) -> Value {
    let id = |m: MaybeId| match m {
        MaybeId::Present(v) => json!(v),
        MaybeId::Missing => Value::Null,
    };
    json!({
        "review_id": r.review_id, "card_id": r.card_id, "note_id": id(r.note_id),
        "deck_id": id(r.deck_id), "preset_id": id(r.preset_id), "day_offset": r.day_offset,
        "elapsed_days": r.elapsed_days, "elapsed_seconds": r.elapsed_seconds,
        "rating": r.rating, "duration": r.duration, "state": r.state,
    })
}

fn predict_input(card: &Card, review_id: i64, day: f64) -> ReviewInput {
    let (elapsed_days, elapsed_seconds) = match card.last {
        Some((d, rid)) => (day - d, ((review_id - rid) / 1000) as f64),
        None => (-1.0, -1.0),
    };
    ReviewInput {
        review_id,
        card_id: card.id,
        note_id: MaybeId::Present(card.note),
        deck_id: MaybeId::Present(card.deck),
        preset_id: MaybeId::Present(1),
        day_offset: day,
        elapsed_days,
        elapsed_seconds,
        rating: None,
        duration: None,
        state: None,
        exact: None,
    }
}

#[test]
fn golden_dump() {
    let Some(out) = std::env::var_os("GOLDEN_OUT") else {
        eprintln!("GOLDEN_OUT not set; skipping");
        return;
    };
    let model = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/models/RWKV_trained_on_101_4999.safetensors");
    let mut rnn = NativeRnn::from_checkpoint(model).expect("load model");
    let mut det = FeatureState::default();

    // 9 notes; note 100 has a forward and a reverse card. 2 decks, 1 preset.
    let mut cards: Vec<Card> = Vec::new();
    for (i, note) in (100..109).enumerate() {
        let deck = if i % 3 == 0 { 11 } else { 10 };
        cards.push(Card { id: note * 10, note, deck, last: None });
        if note == 100 {
            cards.push(Card { id: note * 10 + 1, note, deck, last: None });
        }
    }
    let unseen = Card { id: 9990, note: 999, deck: 10, last: None };

    let mut rng = Lcg(20261123);
    let base_ms: i64 = 1_767_225_600_000; // 2026-01-01T00:00:00Z
    let mut reviews: Vec<Value> = Vec::new();
    let mut predictions: Vec<Value> = Vec::new();
    let mut introduced = 0usize;

    for day in 0..120i64 {
        let dayf = day as f64;
        // Introduce a new card every ~8 days, then review a random subset.
        if day % 8 == 0 && introduced < cards.len() {
            introduced += 1;
        }
        let mut t = base_ms + day * 86_400_000 + 8 * 3_600_000 + rng.below(3_600_000) as i64;
        let mut todo: Vec<usize> = (0..introduced)
            .filter(|&c| cards[c].last.is_none() || rng.below(100) < 35)
            .collect();
        let mut repeats = 0;
        while let Some(c) = todo.first().copied() {
            todo.remove(0);
            t += 20_000 + rng.below(600_000) as i64;
            let (elapsed_days, elapsed_seconds, prev_day) = match cards[c].last {
                Some((d, rid)) => (dayf - d, ((t - rid) / 1000) as f64, Some(d)),
                None => (-1.0, -1.0, None),
            };
            let roll = rng.below(100);
            let rating = if roll < 15 { 1 } else if roll < 30 { 2 } else if roll < 85 { 3 } else { 4 };
            let state = match prev_day {
                None => 1.0,
                Some(_) if elapsed_days > 0.0 => 2.0,
                Some(_) => 1.0,
            };
            let input = ReviewInput {
                review_id: t,
                card_id: cards[c].id,
                note_id: MaybeId::Present(cards[c].note),
                deck_id: MaybeId::Present(cards[c].deck),
                preset_id: MaybeId::Present(1),
                day_offset: dayf,
                elapsed_days,
                elapsed_seconds,
                rating: Some(rating),
                duration: Some((1_500 + rng.below(14_000)) as f64),
                state: Some(state),
                exact: None,
            };

            // Feature vectors on a clone, in the order the Oracle path consumes them.
            let mut probe = det.clone();
            let prow = probe.prepare_predict_row(&input);
            let pf = probe.predict_feature_vector(&prow).expect("predict features");
            let qrow = probe.prepare_process_row(&input).expect("process row");
            let qf = probe.process_feature_vector(&qrow).expect("process features");

            let (probs, _, _) = process_review_inputs_with_state(
                &mut rnn, &mut det, std::slice::from_ref(&input), false, Some(1), &mut None,
            )
            .expect("process");
            reviews.push(json!({
                "input": input_json(&input), "p": probs[0],
                "predict_features": pf, "process_features": qf,
            }));
            cards[c].last = Some((dayf, t));
            // Failed reviews come back the same day (learning / relearning steps).
            if rating == 1 && repeats < 6 {
                repeats += 1;
                todo.push(c);
            }

            if reviews.len() % 25 == 0 {
                let at = t + 60_000;
                let mut inputs: Vec<ReviewInput> = cards[..introduced]
                    .iter()
                    .filter(|c| c.last.is_some())
                    .map(|c| predict_input(c, at, dayf))
                    .collect();
                inputs.push(predict_input(&unseen, at, dayf));
                // Also ask about the future: same cards a week later.
                let later = at + 7 * 86_400_000;
                inputs.extend(
                    cards[..introduced].iter().filter(|c| c.last.is_some()).map(|c| predict_input(c, later, dayf + 7.0)),
                );
                let probs = predict_review_inputs_cpu(&mut rnn, &mut det, &inputs, 1, Some(1), false, None)
                    .expect("predict");
                predictions.push(json!({
                    "after_reviews": reviews.len(),
                    "inputs": inputs.iter().map(input_json).collect::<Vec<_>>(),
                    "p": probs,
                }));
            }
        }
    }

    let doc = json!({
        "generator": "rcfc golden_dump over rwkv-srs v0.1.1 V1 Oracle CPU, 1 thread",
        "model": "RWKV_trained_on_101_4999.safetensors",
        "reviews": reviews,
        "predictions": predictions,
    });
    std::fs::write(&out, serde_json::to_string(&doc).unwrap()).unwrap();
    eprintln!("wrote {} reviews, {} prediction batches", doc["reviews"].as_array().unwrap().len(), doc["predictions"].as_array().unwrap().len());
}

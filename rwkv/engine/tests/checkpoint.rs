//! Checkpoint round trip: replay-all must equal replay-to-k, save, restore into
//! a fresh runtime, replay-rest. Bit for bit.

use rcfc_rwkv::{Kind, ReviewInput, Runtime};
use serde_json::Value;

const MODEL: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../models/RWKV_trained_on_101_4999.safetensors"
);
const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../golden/v1_101_4999.json");

fn reviews() -> Vec<ReviewInput> {
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(GOLDEN).unwrap()).unwrap();
    golden["reviews"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            let v = &r["input"];
            ReviewInput {
                card_id: v["card_id"].as_i64().unwrap(),
                note_id: v["note_id"].as_i64(),
                deck_id: v["deck_id"].as_i64(),
                preset_id: v["preset_id"].as_i64(),
                day_offset: v["day_offset"].as_f64().unwrap(),
                elapsed_days: v["elapsed_days"].as_f64().unwrap(),
                elapsed_seconds: v["elapsed_seconds"].as_f64().unwrap(),
                rating: v["rating"].as_i64(),
                duration: v["duration"].as_f64(),
                state: v["state"].as_f64(),
            }
        })
        .collect()
}

fn queries(rs: &[ReviewInput]) -> Vec<ReviewInput> {
    let last = rs.last().unwrap();
    let mut ids: Vec<_> = rs
        .iter()
        .map(|r| (r.card_id, r.note_id, r.deck_id, r.preset_id))
        .collect();
    ids.sort();
    ids.dedup();
    ids.into_iter()
        .chain([(999_999, Some(42), Some(7), Some(1))]) // unseen card
        .map(|(card_id, note_id, deck_id, preset_id)| ReviewInput {
            card_id,
            note_id,
            deck_id,
            preset_id,
            day_offset: last.day_offset + 3.0,
            elapsed_days: 3.0,
            elapsed_seconds: 3.0 * 86_400.0,
            rating: None,
            duration: None,
            state: None,
        })
        .collect()
}

#[test]
fn restore_continues_bit_for_bit() {
    let model = std::fs::read(MODEL).unwrap();
    let rs = reviews();
    let mut whole = Runtime::new(&model).unwrap();
    let want: Vec<u64> = rs
        .iter()
        .map(|r| whole.process(r).unwrap().to_bits())
        .collect();
    let want_pred: Vec<u64> = whole
        .predict(&queries(&rs))
        .iter()
        .map(|p| p.to_bits())
        .collect();

    for k in [1, 57, 200, rs.len() - 1] {
        let mut a = Runtime::new(&model).unwrap();
        for r in &rs[..k] {
            a.apply(r).unwrap(); // apply == process minus the pre-answer p
        }
        // Two flushes, like the app: a partial one, then the rest.
        let mut saved: std::collections::HashMap<(u8, i64), Vec<u8>> = Default::default();
        let mut flush =
            |rt: &mut Runtime, saved: &mut std::collections::HashMap<(u8, i64), Vec<u8>>| {
                for (kind, id) in rt.take_dirty() {
                    saved.insert((kind as u8, id), rt.state_bytes(kind, id).unwrap());
                }
                rt.features_bytes()
            };
        let _ = flush(&mut a, &mut saved);
        let features = flush(&mut a, &mut saved);
        assert!(a.take_dirty().is_empty());

        let mut b = Runtime::new(&model).unwrap();
        b.load_features(&features).unwrap();
        for ((kind, id), bytes) in &saved {
            b.load_state(Kind::from_u8(*kind).unwrap(), *id, bytes)
                .unwrap();
        }
        assert_eq!(b.reviews_processed(), k as u64);
        let got: Vec<u64> = rs[k..]
            .iter()
            .map(|r| b.process(r).unwrap().to_bits())
            .collect();
        assert_eq!(got, want[k..], "after restore at {k}");
        let got_pred: Vec<u64> = b
            .predict(&queries(&rs))
            .iter()
            .map(|p| p.to_bits())
            .collect();
        assert_eq!(got_pred, want_pred, "predictions after restore at {k}");
    }
}

#[test]
fn rejects_bad_checkpoints() {
    let model = std::fs::read(MODEL).unwrap();
    let mut rt = Runtime::new(&model).unwrap();
    assert!(rt.load_features(&[1, 2, 3]).is_err());
    assert!(rt.load_features(&[9, 0, 0, 0]).is_err());
    let rs = reviews();
    rt.apply(&rs[0]).unwrap();
    let bytes = rt.state_bytes(Kind::Card, rs[0].card_id).unwrap();
    assert!(
        rt.load_state(Kind::Note, 1, &bytes).is_err(),
        "card state has 3 layers, note module 4"
    );
    assert!(rt
        .load_state(Kind::Card, 1, &bytes[..bytes.len() - 4])
        .is_err());
}

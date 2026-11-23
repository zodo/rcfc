//! Long-term usage benchmark: `cargo run --release --example bench`.
//!
//! Simulates a learner who opens the app every day, adds 10 notes (20 cards:
//! forward + reverse) and reviews everything due under a simple doubling
//! schedule (~85% recall, failures repeated the same day). At checkpoints it
//! reports replay cost, per-answer cost, session-start cost and state memory.
//!
//! `BENCH_DUMP=dir` also writes the year as flat f64 rows (see src/wasm.rs) to
//! dir/process.f64 and dir/predict_all.f64, for replaying through Wasm.

use std::time::Instant;

use rcfc_rwkv::{ReviewInput, Runtime};

const MODEL: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../models/RWKV_trained_on_101_4999.safetensors");
const NOTES_PER_DAY: usize = 10;
const CHECKPOINTS: [u32; 3] = [30, 60, 365];

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
}

struct Card {
    id: i64,
    note: i64,
    due_day: u32,
    interval: f64,
    last_secs: Option<f64>,
    state: f64,
}

fn query(c: &Card, now_secs: f64) -> ReviewInput {
    let elapsed = c.last_secs.map_or(-1.0, |l| now_secs - l);
    ReviewInput {
        card_id: c.id,
        note_id: Some(c.note),
        deck_id: Some(1),
        preset_id: Some(1),
        day_offset: (now_secs / 86_400.0).floor(),
        elapsed_days: if elapsed < 0.0 { -1.0 } else { (elapsed / 86_400.0).floor() },
        elapsed_seconds: elapsed,
        rating: None,
        duration: None,
        state: None,
    }
}

fn main() {
    let model = std::fs::read(MODEL).expect("model file");
    let mut rt = Runtime::new(&model).unwrap();
    let mut rng = Rng(42);
    let mut cards: Vec<Card> = Vec::new();
    let mut replay_secs = 0.0f64;
    let mut process_times: Vec<f64> = Vec::new();
    let mut next_id = 1i64;
    let dump = std::env::var("BENCH_DUMP").ok();
    let mut dumped: Vec<f64> = Vec::new();
    let row = |r: &ReviewInput| {
        let n = |v: Option<i64>| v.map_or(f64::NAN, |v| v as f64);
        [r.card_id as f64, n(r.note_id), n(r.deck_id), n(r.preset_id), r.day_offset, r.elapsed_days,
         r.elapsed_seconds, n(r.rating), r.duration.unwrap_or(f64::NAN), r.state.unwrap_or(f64::NAN)]
    };

    println!("{:>5} {:>7} {:>7} {:>9} {:>10} {:>11} {:>12} {:>10}",
        "day", "cards", "reviews", "rev/day", "replay", "answer+50", "predict all", "state MB");
    for day in 1..=*CHECKPOINTS.last().unwrap() {
        for _ in 0..NOTES_PER_DAY {
            let note = next_id;
            next_id += 1;
            for _ in 0..2 {
                cards.push(Card { id: next_id, note, due_day: day, interval: 0.0, last_secs: None, state: 0.0 });
                next_id += 1;
            }
        }
        // Session at 08:00, one answer every ~8 s.
        let mut t = (day as f64 - 1.0) * 86_400.0 + 8.0 * 3600.0;
        let mut queue: Vec<usize> = (0..cards.len()).filter(|&i| cards[i].due_day <= day).collect();
        let mut today = 0;
        while let Some(i) = queue.pop() {
            let c = &mut cards[i];
            let recalled = rng.next() < 0.85;
            let rating = if !recalled { 1 } else if rng.next() < 0.15 { 4 } else { 3 };
            let mut input = query(c, t);
            input.rating = Some(rating);
            input.duration = Some(3000.0 + 6000.0 * rng.next());
            input.state = Some(c.state);
            if dump.is_some() {
                dumped.extend(row(&input));
            }
            let start = Instant::now();
            rt.process(&input).unwrap();
            let dt = start.elapsed().as_secs_f64();
            replay_secs += dt;
            process_times.push(dt);
            today += 1;
            c.last_secs = Some(t);
            if recalled {
                c.interval = if c.interval < 1.0 { 1.0 } else { c.interval * 2.5 };
                c.due_day = day + c.interval.round() as u32;
                c.state = 2.0;
            } else {
                c.interval = 0.0;
                c.state = if c.state == 0.0 { 1.0 } else { 3.0 };
                queue.insert(0, i); // again later today
            }
            t += 8.0;
        }

        if CHECKPOINTS.contains(&day) {
            // Live answer: one process + re-predict 50 candidates.
            let candidates: Vec<ReviewInput> = cards.iter().take(50).map(|c| query(c, t)).collect();
            let start = Instant::now();
            let reps = 20;
            for _ in 0..reps {
                rt.predict(&candidates);
            }
            let predict50 = start.elapsed().as_secs_f64() / reps as f64;
            process_times.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let process_median = process_times[process_times.len() / 2];

            let all: Vec<ReviewInput> = cards.iter().map(|c| query(c, t)).collect();
            if let (Some(dir), true) = (&dump, day == *CHECKPOINTS.last().unwrap()) {
                let bytes = |v: &[f64]| v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
                std::fs::write(format!("{dir}/process.f64"), bytes(&dumped)).unwrap();
                std::fs::write(format!("{dir}/predict_all.f64"), bytes(&all.iter().flat_map(row).collect::<Vec<_>>())).unwrap();
            }
            let start = Instant::now();
            rt.predict(&all);
            let predict_all = start.elapsed().as_secs_f64();

            println!("{:>5} {:>7} {:>7} {:>9} {:>9.1}s {:>9.1}ms {:>11.0}ms {:>10.0}",
                day, cards.len(), rt.reviews_processed(), today, replay_secs,
                (process_median + predict50) * 1e3, predict_all * 1e3,
                rt.state_bytes() as f64 / 1e6);
        }
    }
}

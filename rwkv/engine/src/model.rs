//! RWKV-SRS V1 network, single-row recurrent ("Oracle") inference in f32.
//! Math follows srs-benchmark `rwkv_rnn_model.py` / `srs_model_rnn.py`, as
//! implemented by rwkv-srs v0.1.1. Only the RWKV-P (immediate) head is used.

use std::collections::HashMap;

use crate::features::FEATURE_LEN;

const D: usize = 128;
const H: usize = 4;
const K: usize = 32;
const LN_EPS: f32 = 1e-5;
const GN_EPS: f32 = 64e-5;
const L2_MIN: f32 = 1e-12;
/// Module order in the network: card, deck, note, preset, global.
pub const MODULES: usize = 5;

struct Linear {
    w: Vec<f32>, // [out, in] row-major
    b: Option<Vec<f32>>,
    inp: usize,
    out: usize,
}

impl Linear {
    fn apply(&self, x: &[f32], y: &mut [f32]) {
        debug_assert_eq!(x.len(), self.inp);
        for o in 0..self.out {
            let row = &self.w[o * self.inp..(o + 1) * self.inp];
            y[o] = dot(row, x) + self.b.as_ref().map_or(0.0, |b| b[o]);
        }
    }
    fn call(&self, x: &[f32]) -> Vec<f32> {
        let mut y = vec![0.0; self.out];
        self.apply(x, &mut y);
        y
    }
}

/// Dot product with 32 independent accumulators so LLVM can vectorize it
/// (a single f32 accumulator forces strict sequential order).
#[inline]
fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut acc = [0.0f32; 32];
    let (ac, bc) = (a.chunks_exact(32), b.chunks_exact(32));
    let (ar, br) = (ac.remainder(), bc.remainder());
    for (x, y) in ac.zip(bc) {
        for l in 0..32 {
            acc[l] += x[l] * y[l];
        }
    }
    let mut s = acc.iter().sum::<f32>();
    for (x, y) in ar.iter().zip(br) {
        s += x * y;
    }
    s
}

struct Norm {
    w: Vec<f32>,
    b: Vec<f32>,
}

impl Norm {
    fn layer(&self, x: &[f32]) -> Vec<f32> {
        let n = x.len() as f32;
        let mean = x.iter().sum::<f32>() / n;
        let var = x.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / n;
        let inv = 1.0 / (var + LN_EPS).sqrt();
        x.iter().enumerate().map(|(i, v)| (v - mean) * inv * self.w[i] + self.b[i]).collect()
    }
    /// GroupNorm with H groups over D channels.
    fn group(&self, x: &[f32]) -> Vec<f32> {
        let mut y = vec![0.0; D];
        for h in 0..H {
            let g = &x[h * K..(h + 1) * K];
            let mean = g.iter().sum::<f32>() / K as f32;
            let var = g.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / K as f32;
            let inv = 1.0 / (var + GN_EPS).sqrt();
            for j in 0..K {
                let c = h * K + j;
                y[c] = (g[j] - mean) * inv * self.w[c] + self.b[c];
            }
        }
        y
    }
}

struct TimeMixer {
    ln: Norm,
    lerp: Vec<f32>, // [8, D]
    bonus: Vec<f32>, // [H*K]
    w_r: Linear,
    w_k: Linear,
    w_v: Linear,
    w_o: Linear,
    k_scale: Linear,
    v_scale: Linear,
    v_lora: (Linear, Linear),
    a_lora: (Linear, Linear),
    d_lora: (Linear, Linear),
    g_a: Linear,
    g_b: Linear,
    gn: Norm,
}

struct ChannelMixer {
    ln: Norm,
    lerp_k: Vec<f32>,
    w_k: Linear,
    w_v: Linear,
}

struct Layer {
    time: TimeMixer,
    channel: ChannelMixer,
}

/// Recurrent state of one layer.
#[derive(Clone, Debug)]
pub struct LayerState {
    pub time_shift: Vec<f32>,   // [D]
    pub time_state: Vec<f32>,   // [H, K, K]
    pub channel_shift: Vec<f32>, // [D]
}

/// Recurrent state of one module (card, note, deck, preset or global).
pub type ModuleState = Vec<LayerState>;

pub struct Weights {
    f2c_0: Linear,
    f2c_ln: Norm,
    f2c_3: Linear,
    modules: Vec<Vec<Layer>>,
    prehead: Norm,
    head_p: Linear,
    p_linear: Linear,
}

fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}
fn silu(x: f32) -> f32 {
    x * sigmoid(x)
}
fn softplus(x: f32) -> f32 {
    // torch softplus with threshold 20
    if x > 20.0 { x } else { x.exp().ln_1p() }
}

fn l2_normalize_head(x: &mut [f32]) {
    let n = x.iter().map(|v| v * v).sum::<f32>().sqrt().max(L2_MIN);
    for v in x.iter_mut() {
        *v /= n;
    }
}

impl Layer {
    fn forward(&self, layer_id: usize, input: &[f32], v0: &mut Vec<f32>, state: Option<&LayerState>) -> (Vec<f32>, LayerState) {
        let t = &self.time;
        // ---- time mixer ----
        let x = t.ln.layer(input);
        let xs: &[f32] = state.map_or(&x, |s| &s.time_shift);
        let mix = |j: usize| -> Vec<f32> { (0..D).map(|c| x[c] + t.lerp[j * D + c] * (xs[c] - x[c])).collect() };
        let r = t.w_r.call(&mix(0));
        let mut k = t.w_k.call(&mix(1));
        let mv = mix(2);
        let k_scale: Vec<f32> = t.k_scale.call(&mix(6)).into_iter().map(sigmoid).collect();
        let v_scale: Vec<f32> = t.v_scale.call(&mix(7)).into_iter().map(sigmoid).collect();
        let mut v = t.w_v.call(&mv);
        if layer_id == 0 {
            *v0 = v.clone();
        } else {
            let lerp = t.v_lora.1.call(&t.v_lora.0.call(&mv));
            for c in 0..D {
                v[c] += sigmoid(lerp[c]) * (v0[c] - v[c]);
            }
        }
        let a: Vec<f32> = t.a_lora.1.call(&t.a_lora.0.call(&mix(4))).into_iter().map(sigmoid).collect();
        let g = t.g_b.call(&t.g_a.call(&mix(5)).into_iter().map(sigmoid).collect::<Vec<_>>());
        let dlo: Vec<f32> = t.d_lora.0.call(&mix(3)).into_iter().map(f32::tanh).collect();
        let w: Vec<f32> = t.d_lora.1.call(&dlo).into_iter().map(|d| (-(-0.5 - softplus(-d)).exp()).exp()).collect();

        for h in 0..H {
            l2_normalize_head(&mut k[h * K..(h + 1) * K]);
            l2_normalize_head(&mut v[h * K..(h + 1) * K]);
            for j in 0..K {
                k[h * K + j] *= k_scale[h];
                v[h * K + j] *= v_scale[h];
            }
        }
        let k_def = k.clone();
        let ka: Vec<f32> = (0..D).map(|c| k[c] * a[c]).collect();

        let mut s = state.map_or_else(|| vec![0.0f32; H * K * K], |st| st.time_state.clone());
        let mut out = vec![0.0f32; D];
        for h in 0..H {
            let o = h * K;
            let sh = &mut s[h * K * K..(h + 1) * K * K];
            for i in 0..K {
                let row = &mut sh[i * K..(i + 1) * K];
                let mut sa = 0.0f32;
                for j in 0..K {
                    sa += row[j] * k_def[o + j];
                }
                let mut acc = 0.0f32;
                for j in 0..K {
                    let nv = row[j] * w[o + j] - sa * (a[o + j] * k_def[o + j]) + v[o + i] * ka[o + j];
                    row[j] = nv;
                    acc += nv * r[o + j];
                }
                out[o + i] = acc;
            }
        }
        let mut y = t.gn.group(&out);
        for h in 0..H {
            let o = h * K;
            let mut dot = 0.0f32;
            for j in 0..K {
                dot += r[o + j] * t.bonus[o + j] * ka[o + j];
            }
            for i in 0..K {
                y[o + i] = g[o + i] * (y[o + i] + dot * v[o + i]);
            }
        }
        let o = t.w_o.call(&y);
        let after_time: Vec<f32> = (0..D).map(|c| input[c] + o[c]).collect();

        // ---- channel mixer ----
        let cm = &self.channel;
        let xc = cm.ln.layer(&after_time);
        let xcs: &[f32] = state.map_or(&xc, |s| &s.channel_shift);
        let mixed: Vec<f32> = (0..D).map(|c| xc[c] + cm.lerp_k[c] * (xcs[c] - xc[c])).collect();
        let kk: Vec<f32> = cm.w_k.call(&mixed).into_iter().map(|v| { let r = v.max(0.0); r * r }).collect();
        let o2 = cm.w_v.call(&kk);
        let out: Vec<f32> = (0..D).map(|c| after_time[c] + o2[c]).collect();

        (out, LayerState { time_shift: x, time_state: s, channel_shift: xc })
    }
}

impl Weights {
    pub fn from_safetensors(bytes: &[u8]) -> Result<Self, String> {
        let t = Tensors::parse(bytes)?;
        let lin = |name: &str, bias: bool| t.linear(name, bias);
        let norm = |name: &str| -> Result<Norm, String> { Ok(Norm { w: t.get(&format!("{name}.weight"))?, b: t.get(&format!("{name}.bias"))? }) };
        let mut modules = Vec::new();
        for m in 0..MODULES {
            let mut layers = Vec::new();
            let mut l = 0;
            while t.has(&format!("rwkv_modules.{m}.blocks.{l}.time_mixer.W_r.weight")) {
                let p = format!("rwkv_modules.{m}.blocks.{l}");
                let tm = |s: &str| format!("{p}.time_mixer.{s}");
                let lora = |s: &str| -> Result<(Linear, Linear), String> { Ok((lin(&tm(&format!("{s}.A")), false)?, lin(&tm(&format!("{s}.B_and_lamb")), true)?)) };
                layers.push(Layer {
                    time: TimeMixer {
                        ln: norm(&tm("layer_norm"))?,
                        lerp: t.get(&tm("rkvdag_lerp"))?,
                        bonus: t.get(&tm("bonus"))?,
                        w_r: lin(&tm("W_r"), false)?,
                        w_k: lin(&tm("W_k"), false)?,
                        w_v: lin(&tm("W_v"), false)?,
                        w_o: lin(&tm("W_o"), false)?,
                        k_scale: lin(&tm("k_scale_linear"), true)?,
                        v_scale: lin(&tm("v_scale_linear"), true)?,
                        v_lora: lora("v_lora_simple")?,
                        a_lora: lora("a_lora_simple")?,
                        d_lora: lora("d_lora_mlp")?,
                        g_a: lin(&tm("lora_A_g"), false)?,
                        g_b: lin(&tm("lora_B_g"), false)?,
                        gn: norm(&tm("out_group_norm"))?,
                    },
                    channel: ChannelMixer {
                        ln: norm(&format!("{p}.channel_mixer.layer_norm"))?,
                        lerp_k: t.get(&format!("{p}.channel_mixer.lerp_k"))?,
                        w_k: lin(&format!("{p}.channel_mixer.W_k"), false)?,
                        w_v: lin(&format!("{p}.channel_mixer.W_v"), false)?,
                    },
                });
                l += 1;
            }
            if layers.is_empty() {
                return Err(format!("model has no layers for module {m}"));
            }
            modules.push(layers);
        }
        let w = Weights {
            f2c_0: lin("features2card.0", true)?,
            f2c_ln: norm("features2card.2")?,
            f2c_3: lin("features2card.3", true)?,
            modules,
            prehead: norm("prehead_norm")?,
            head_p: lin("head_p.0", true)?,
            p_linear: lin("p_linear", true)?,
        };
        if w.f2c_0.inp != FEATURE_LEN {
            return Err(format!("model expects {} features, engine produces {FEATURE_LEN}", w.f2c_0.inp));
        }
        Ok(w)
    }

    /// One review row through the whole network. `states[m]` is the current state
    /// of module m (None = fresh). Returns P(recall) and the next states.
    pub fn forward(&self, features: &[f32], states: [Option<&ModuleState>; MODULES]) -> (f64, [ModuleState; MODULES]) {
        let h = self.f2c_0.call(features).into_iter().map(silu).collect::<Vec<_>>();
        let h = self.f2c_ln.layer(&h);
        let mut x: Vec<f32> = self.f2c_3.call(&h).into_iter().map(silu).collect();
        let mut next: Vec<ModuleState> = Vec::with_capacity(MODULES);
        for (m, layers) in self.modules.iter().enumerate() {
            let mut v0 = vec![0.0f32; D];
            let mut ms = Vec::with_capacity(layers.len());
            for (l, layer) in layers.iter().enumerate() {
                let st = states[m].map(|s| &s[l]);
                let (y, ls) = layer.forward(l, &x, &mut v0, st);
                x = y;
                ms.push(ls);
            }
            next.push(ms);
        }
        let z = self.prehead.layer(&x);
        let hp: Vec<f32> = self.head_p.call(&z).into_iter().map(|v| v.max(0.0)).collect();
        let logits = self.p_linear.call(&hp);
        let max = logits.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        let exps: Vec<f32> = logits.iter().map(|l| (l - max).exp()).collect();
        let p_again = exps[0] / exps.iter().sum::<f32>();
        let p = (1.0 - p_again as f64).clamp(1e-5, 1.0 - 1e-5);
        (p, next.try_into().map_err(|_| ()).unwrap())
    }
}

/// Minimal safetensors reader (F32 only).
struct Tensors<'a> {
    data: &'a [u8],
    index: HashMap<String, (Vec<usize>, usize, usize)>,
}

impl<'a> Tensors<'a> {
    fn parse(bytes: &'a [u8]) -> Result<Self, String> {
        if bytes.len() < 8 {
            return Err("model file too small".into());
        }
        let n = u64::from_le_bytes(bytes[..8].try_into().unwrap()) as usize;
        let header: serde_json::Value = serde_json::from_slice(bytes.get(8..8 + n).ok_or("truncated header")?).map_err(|e| e.to_string())?;
        let mut index = HashMap::new();
        for (name, v) in header.as_object().ok_or("bad header")? {
            if name == "__metadata__" {
                continue;
            }
            if v["dtype"] != "F32" {
                return Err(format!("{name}: only F32 supported, got {}", v["dtype"]));
            }
            let shape = v["shape"].as_array().ok_or("bad shape")?.iter().map(|d| d.as_u64().unwrap() as usize).collect();
            let off = v["data_offsets"].as_array().ok_or("bad offsets")?;
            index.insert(name.clone(), (shape, off[0].as_u64().unwrap() as usize, off[1].as_u64().unwrap() as usize));
        }
        Ok(Self { data: &bytes[8 + n..], index })
    }
    fn has(&self, name: &str) -> bool {
        self.index.contains_key(name)
    }
    fn shape(&self, name: &str) -> Result<&[usize], String> {
        Ok(&self.index.get(name).ok_or_else(|| format!("missing tensor {name}"))?.0)
    }
    fn get(&self, name: &str) -> Result<Vec<f32>, String> {
        let (_, a, b) = self.index.get(name).ok_or_else(|| format!("missing tensor {name}"))?;
        let raw = self.data.get(*a..*b).ok_or_else(|| format!("tensor {name} out of bounds"))?;
        Ok(raw.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect())
    }
    fn linear(&self, name: &str, bias: bool) -> Result<Linear, String> {
        let wn = format!("{name}.weight");
        let s = self.shape(&wn)?.to_vec();
        Ok(Linear { w: self.get(&wn)?, b: if bias { Some(self.get(&format!("{name}.bias"))?) } else { None }, out: s[0], inp: s[1] })
    }
}

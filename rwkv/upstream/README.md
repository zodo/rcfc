# RWKV-SRS

RWKV-SRS is a Rust-backed Python runtime for recurrent spaced-repetition
inference. Its native backend supports scalar and batched review processing,
CPU Oracle/Fast prediction, optional wgpu prediction and processing, atomic
checkpoints, LIFO undo, and Rust-owned live prediction sessions.

The public Python package is a thin facade over the Rust/PyO3 implementation.
It has no Torch dependency and lazily loads its native extension.

## Attribution and AI authorship

RWKV-SRS originated from the
[RWKV implementation](https://github.com/open-spaced-repetition/srs-benchmark/tree/main/rwkv)
in the Open Spaced Repetition `srs-benchmark` project, authored by
[1DWalker](https://github.com/1DWalker). We gratefully acknowledge that work as
the foundation of this project.

**AI-authorship disclaimer:** This entire RWKV-SRS project—including its
adaptation, Rust implementation, Python bindings, tests, tooling,
documentation, and subsequent development—was coded by OpenAI's Codex under
human direction. This statement does not supersede the attribution above for
the original RWKV source on which the project was based.

Third-party attributions and exact locked dependency license texts are recorded
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt).

> The API and checkpoint format are still pre-1.0. Pin an exact package version
> and retain checkpoint backups while integrating it.

See the [0.1.1 release notes](docs/RELEASE_NOTES.md) for V5o-a support,
precision options, checkpoint changes, and the scope of local validation.

## Models

The generic wheel is intentionally model-free. Construct a new runtime with an
explicit path to a compatible Safetensors model:

```python
from rwkv_srs import RWKV_SRS

runtime = RWKV_SRS(model="/path/to/model.safetensors")
```

The repository retains two runtime-supported V1 Safetensors models under
`tests/fixtures/models/`, with hashes and origin recorded beside them, and
`rwkv-p-v5o/`, containing V5o-a. V5o-a is experimental, with a reported marginal
LogLoss improvement over V1 (less than 1% relative reduction), and is intended
to be superseded by a future model.
V1 and V5o support readable CPU Oracle, portable/custom-SIMD CPU Fast, and
optional GPU execution.
Select V5o-a with `RWKV_SRS(model="rwkv-p-v5o", cpu_mode="fast")` in a source
checkout or a downstream package that supplies its weights. V5o has exact
integer-clock inputs and optional first-answer predictions, distinct from V1.
Use `rebuild_retained_history()` to atomically reconstruct V5o state after card
deletions or catalog metadata changes, supplying the full current catalog and
ordered history. Oracle, Fast, and GPU modes are supported.
V5o GPU ranking uses FP16 cached state/weights when supported, with FP32 math;
canonical processing state and checkpoints default to FP32, with optional
FP16 card/note storage.
See the [V5o integration guide](docs/V5O_DOWNSTREAM_INTEGRATION.md) for the
input contract, precision choices, and limitations.
All repository models are excluded from generic wheels and source
distributions. Downstream applications may deliberately copy a supported model
under `rwkv_srs/pretrained/`; named lookup then works without requiring their
users to locate a model manually.

Model identity and capabilities can be checked without constructing a runtime:

```python
from rwkv_srs import inspect_model_artifact

info = inspect_model_artifact("/path/to/model.safetensors")
print(info.model_version, info.capabilities)
```

New runtime checkpoints bind the exact model version, schemas, output contract,
and artifact hash. Older identity-free checkpoints remain readable as V1 only.
If the saved model path is no longer available, supply its new location when
restoring:

```python
runtime = RWKV_SRS(
    checkpoint="/path/to/history.bin",
    checkpoint_model="/new/location/model.safetensors",
)
```

`checkpoint_model=` accepts an explicit path, not a model name. It requires
the **same artifact bytes**, verified against the checkpoint's recorded identity;
it cannot substitute different weights or override identity-free legacy
checkpoints. Without it, the original model lookup is unchanged. Subsequent
saves record the replacement's absolute path. FP16 checkpoints still require
`state_precision="fp16"`.

Model parameters and loaded checkpoint tensors must be finite: loading rejects
NaN and infinity before publishing state. This validation runs at load time,
not on every prediction or review. A selective V1 checkpoint load validates the
tensors it loads; it does not scan unrequested state.

Omitting `seed` selects the native deterministic seed `5489`.

### Model-specific inputs and outputs

V1 uses scheduler-context rows and supports retrievability curves. V5o uses
integer-millisecond query/answer rows and predicts an immediate Pass probability;
an initial answer without a pre-answer query returns `None`, and curve requests
are rejected. Each model has its own input and checkpoint contract.

Use `cpu_mode="fast"` for scalar Fast execution and as the default for mutating
batch calls. Pass `mode="fast"` or `mode="gpu"` explicitly to `predict_many()`;
its default remains Oracle. `ReviewBatch` and `PredictionBatch` provide V1
transport, while `V5oReviewBatch` provides V5o mapping, columnar, and buffer input.
See the [V5o integration guide](docs/V5O_DOWNSTREAM_INTEGRATION.md) for exact
fields, retained-history rebuilds, Live Session clocks, undo, and packaging.

### Optional FP16 card/note storage

Both V1 and V5o accept an immutable, per-runtime storage choice:

```python
runtime = RWKV_SRS(
    model="/path/to/model.safetensors",
    cpu_mode="fast",
    state_precision="fp16",  # omitted or "fp32" preserves full-precision state
)
```

This halves the recurrent tensor payload for cards and notes in CPU RAM and
resident GPU processing arenas. Deck, preset and collection state remain FP32.
CPU/GPU computation widens state to FP32, then rounds each card/note successor
after **every answer**, including answers within a batch. Predictions do not
update state. Temporary calculation buffers, model weights, metadata and undo
overheads are not halved, so total memory usage falls by less than 50%.
FP16 is lossy and opt-in; validate metrics with your model and workload.

V1 Fast CPU batch predictions use an optimized FP32 readout directly from
FP16 storage on AVX2/FMA/F16C CPUs; other CPUs retain the portable fallback.
This is enabled automatically, with no additional precision selection. For
diagnostics, `RWKV_SRS_CPU_FAST_HALF_READOUT=0` restores the previous loading
path; `RWKV_SRS_CPU_FAST_HALF_ALGEBRAIC=0` disables only the algebraic readout.
Neither optimization changes processing, checkpoint contents, or stored state.

V5o Fast CPU predictions likewise borrow FP16 recurrent storage, widening one
small row at a time for FP32 calculations. An algebraically simplified readout
also reduces work, with tiny FP32 rounding differences in predictions. Both are
enabled automatically; `RWKV_SRS_V5O_CPU_DIRECT_HALF_STATE=0` selects the previous
loading route, and `RWKV_SRS_V5O_CPU_HALF_ALGEBRAIC=0` disables only the simplified
readout. V5o processing, its internal feedback predictions, and stored state are
unchanged.

`process()`, `process_many()`, `build_state_only()`, undo, checkpoint loading,
and Live Sessions honor the same choice. V5o retained-history rebuilds do too.
Scalar processing remains CPU; batch processing can select `mode="gpu"`.
GPU prediction caches have a separate existing capability-driven policy and
may already use FP16 with the default runtime. Explicit FP16 state storage
uses FP32 prediction arithmetic; it does not enable half-precision math.

Checkpoints persist the runtime's choice: FP16 card/note tensor payloads use
half the disk space; other tensors and metadata retain their original types.
Pass `state_precision="fp16"` when loading an FP16 checkpoint—loading it as
FP32 (including the default) is rejected. Conversion is one-way: load an FP32
checkpoint with `state_precision="fp16"`, then save it to create an FP16
checkpoint. CPU, GPU and checkpoint conversion share explicit binary16
round-to-nearest, ties-to-even semantics.

```python
with RWKV_SRS(checkpoint="full.bin", state_precision="fp16") as runtime:
    runtime.save_checkpoint("compact.bin")
```

`runtime.state_storage_info()` reports canonical tensor payload bytes and FP16
entity counts by stream; this diagnostic synchronizes deferred GPU state first.

### Optional FP16 GPU prediction math (V1 and V5o)

Both models can independently opt into half-precision arithmetic for GPU predictions:

```python
with RWKV_SRS(
    model="/path/to/v1-model.safetensors",
    gpu_prediction_math="fp16",
    state_precision="fp32",  # independent choice for canonical state storage
) as runtime:
    runtime.process_many(history, mode="fast", return_curves=False)
    probabilities = runtime.predict_many(cards, mode="gpu")
    print(runtime.gpu_profile()["prediction_math"])  # actual: "fp16" or "fp32"
```

Omitting `gpu_prediction_math` uses FP32 by default. Explicit `"fp32"` or
`"fp16"` is immutable and belongs to that runtime, including its GPU Live
Session refreshes and `predict_many_f32()` calls. The FP16 option selects the
complete optimized path automatically; no environment variables are needed.
CPU inference, processing, and checkpoint contents retain their existing
precision rules. For V5o, this also leaves the state-producing pre-answer
prediction and compact feedback on their existing FP32 processing path.

Initialization tries optimized FP16 kernels, compatible FP16 kernels, then
FP32. Inspect `requested_prediction_math`, `prediction_math`, and
`prediction_math_fallback_reason` in `gpu_profile()` to see the outcome.
An unavailable GPU still follows the existing `fallback_mode` contract.
GPU predictions can differ numerically. FP16 error and performance depend on
the model, workload, and GPU; validate this opt-in for your application.
See the
[GPU prediction contract](docs/PUBLIC_RELEASE.md#gpu-prediction-math).

## Build and test

RWKV-SRS requires Python 3.11 or newer and a Rust toolchain. For development:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -U pip
python -m pip install -e ".[dev]"
RWKV_SRS_BACKEND=rust python -m pytest -q tests/release
```

Raw Cargo tests do not require linking a Python extension. The public
repository already contains the two models used by the native tests:

```bash
cargo test --manifest-path rust/rwkv-srs-cpu/Cargo.toml
```

The declared Rust MSRV is 1.87. Release and development tooling is pinned by
`rust-toolchain.toml`; public CI checks both the MSRV and pinned toolchain.

The independent Python release suite still generates its own small,
schema-conformant synthetic model and does not derive expected outputs from the
repository-trained weights.

Build and exercise an installed wheel plus a rebuilt source distribution in
fresh environments outside the checkout:

```bash
python scripts/validate_public_release.py
```

### Manual wheel and native-extension builds

Use any Python 3.11-or-newer installation with the Rust build tools installed,
then select either a portable `release` build or a host-tuned `native` build.
The build always runs directly on the current machine. A virtual environment
is optional and only isolates Python build-tool dependencies; it does not
change CPU detection or native code generation.

On Linux or macOS:

```bash
python3 -m pip install ".[rust-build]"

# Portable release-ci output for distribution on this OS/architecture.
python3 scripts/build_local_artifact.py release --artifact both

# Host-tuned release-local output for this machine only.
python3 scripts/build_local_artifact.py native --artifact both
```

On Windows PowerShell:

```powershell
py -3.11 -m pip install ".[rust-build]"

# Portable release-ci wheel and extracted .pyd.
py -3.11 .\scripts\build_local_artifact.py `
  release --artifact both

# Host-tuned release-local wheel and extracted .pyd.
py -3.11 .\scripts\build_local_artifact.py `
  native --artifact both
```

`--artifact` accepts `wheel`, `extension`, or `both`:

- `wheel` retains only the complete installable wheel.
- `extension` retains only `_native.pyd` on Windows or `_native*.so` on
  Linux/macOS.
- `both`, the default, retains both outputs.

Outputs are written to `dist/local/release/` or `dist/local/native/` by
default. Pass `--out-dir <path>` to choose another directory. Every build also
writes `build-info.json` containing the selected profile and output hashes.

Native builds use `target-cpu=native` and must not be redistributed to CPUs
that may lack the same instruction-set features. An extracted native extension
still requires the Python files in the `rwkv_srs` package; retain the wheel
when a complete installable artifact is needed.

Linux release wheels are built with Zig and are required to carry the exact
`manylinux_2_38` compatibility tag. The release test suite also runs the Fast
path with SIMD forced off and verifies typed GPU-unavailable recovery without
requiring GPU hardware.

## Public source export

The public tree is generated from an exact clean commit using a classified
positive allowlist:

```bash
python scripts/public_release_export.py --check-only
python scripts/public_release_export.py --out-dir ../rwkv-srs-public
```

Every tracked file must be classified. The export records its source commit and
the mode, size, and SHA-256 of every copied source file in
`PUBLIC_EXPORT_PROVENANCE.json`.

See [docs/PUBLIC_RELEASE.md](docs/PUBLIC_RELEASE.md) for the artifact and export
contract and
[rust/rwkv-srs-cpu/README.md](rust/rwkv-srs-cpu/README.md) for the native crate.

## Internal development checkout

The private development checkout may contain a frozen Torch oracle, extended
corpora, benchmarks, PGO tooling, and experiment records. Those are used for
differential qualification and performance work; they are not part of the
generated public repository or Rust-only artifacts. The public repository is a
generated distribution mirror; the private repository remains canonical.

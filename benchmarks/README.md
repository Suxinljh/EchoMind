# EchoMind ASR Gate 0

This directory tracks the ASR feasibility test described in PRD V1.1. Original recordings and manual transcripts stay in `private/`, which is excluded from Git.

## Candidate acceptance checks

- Event-level filler F1 and recall: target at least 85%, with documented matching tolerance.
- Stable interim/final text and no duplicate event counts after revisions.
- Continuous 20-minute input without crashes or recording interruption on the selected minimum Mac and browser.
- Inference throughput, queue growth, model size, load time, peak memory, and device/browser recorded.
- Pause events measured from audio, with user-initiated pauses excluded.

These are candidate thresholds, not measured results. PRD V1.1 proposes 15–20 authorized natural Chinese speech clips. The user has capped this Gate 0 recording set at six clips. This reduced set supports an exploratory decision but cannot validate the PRD's proposed sample coverage or a broad accuracy claim. Human verbatim transcripts are now recorded in `private/manual-review.md`; the comparison is in `private/gate0-comparison.md`.

## Annotation fields

For each clip, record recording permission/source, speaker/context, verbatim transcript, filler events (word and start/end time), repeated phrases (text and time), acoustic silences (start/end time), and likely semantic boundaries. Do not normalize away fillers or repetitions in the reference transcript.

## Current sample

| ID | File | Duration | Codec | Sample rate | Channels | Status |
| --- | --- | ---: | --- | ---: | ---: | --- |
| 001 | `private/sample-001.m4a` | 79.403 s | AAC | 48 kHz | 2 | Human verbatim transcript received |
| 002 | `private/sample-002.m4a` | 23.893 s | AAC | 48 kHz | 1 | Human verbatim transcript received |
| 003 | `private/sample-003.m4a` | 27.008 s | AAC | 48 kHz | 1 | Human verbatim transcript received |
| 004 | `private/sample-004.m4a` | 69.675 s | AAC | 48 kHz | 1 | Human verbatim transcript received |
| 005 | `private/sample-005.m4a` | 24.491 s | AAC | 48 kHz | 1 | Human verbatim transcript received |
| 006 | `private/sample-006.m4a` | 54.912 s | AAC | 48 kHz | 1 | Human verbatim transcript received |

The initial measurement host is macOS 26.6.1, Intel Core i9-9980HK, 32 GB RAM. Browser baseline remains to be confirmed; Chrome is the working assumption. Windows is outside the V1 support target.

## First local candidate run

The official [sherpa-onnx Chinese 14M streaming Zipformer model](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html) was tested with the native Python CPU runtime, using 200 ms chunks after conversion to 16 kHz mono. The compressed model package is about 80 MB on disk. Decoding 79.403 s of audio took 2.188 s (real-time factor 0.028) on the host above. The private raw and partial transcripts are in `private/sample-001-sherpa.json`.

The 398 sampled partial results for clip 001 changed text 107 times during decoding. This is not a final-segment stability test: endpointing, browser WASM, audio-input pacing, and UI responsiveness remain untested. Token-level timestamps are now captured but need manual tolerance checks. Without a human verbatim reference, filler F1/recall and transcript accuracy cannot be calculated.

| Sample | Native decode time | Real-time factor |
| --- | ---: | ---: |
| 001 | 2.188 s | 0.028 |
| 002 | 2.307 s | 0.097 |
| 003 | 2.522 s | 0.093 |
| 004 | 3.758 s | 0.054 |
| 005 | 2.390 s | 0.098 |
| 006 | 3.403 s | 0.062 |

These figures are native CPU inference on this host, not browser performance or quality measurements. The editable listening checklist is `private/manual-review.md`.

An initial FFmpeg volume-threshold scan (`silencedetect=noise=-35dB:d=1`) found nine >=1 s candidate silent intervals. Two exceed the PRD's default 3 s display threshold: approximately 24.28–29.88 s and 33.11–37.09 s. These are acoustic candidates only; they require listening/context review and are not VAD results or quality judgments.

Run the candidate again with `private/venv/bin/python benchmarks/streaming_spike.py benchmarks/private/sample-001.m4a benchmarks/private/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23 benchmarks/private/sample-001-sherpa.json`.

## Next Gate 0 work

1. The two tested native models fail the candidate 85% filler target on the six reference transcripts: the 14M model recognized none of 18 clear `嗯/呃` events; the 2025 Chinese int8 model has an optimistic filler F1 upper bound of 80%. See `private/gate0-comparison.md` for the calculation and examples.
2. Test another local candidate or decoding strategy against these same six recordings if precise filler scoring remains required. Do not publish that score based on either current model.
3. Run browser WASM and 20-minute continuous-input tests only for a candidate that first passes the content-preservation check; assess model download, memory, latency, and UI response.

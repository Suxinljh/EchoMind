"""Run a local sherpa-onnx streaming candidate against one authorized recording.

This is an intake experiment, not the browser/WASM Gate 0 acceptance test.
Output can contain private speech and should be written under benchmarks/private/.
"""

import argparse
import json
import subprocess
import time
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", type=Path)
    parser.add_argument("model", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    model = args.model
    def model_file(pattern: str) -> str:
        matches = sorted(model.glob(pattern))
        if len(matches) != 1:
            raise ValueError(f"Expected one {pattern} in {model}, got {matches}")
        return str(matches[0])

    recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(model / "tokens.txt"),
        encoder=model_file("encoder*.int8.onnx"),
        decoder=model_file("decoder*.onnx") if len(list(model.glob("decoder*.onnx"))) == 1 else model_file("decoder-epoch-99-avg-1.onnx"),
        joiner=model_file("joiner*.int8.onnx"),
        num_threads=2,
        sample_rate=16000,
        enable_endpoint_detection=False,
    )

    wav_path = args.output.with_suffix(".wav")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(args.audio),
         "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav_path)],
        check=True,
    )
    with wave.open(str(wav_path), "rb") as wav:
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32) / 32768

    stream = recognizer.create_stream()
    partials = []
    start = time.perf_counter()
    chunk_size = 3200  # 200 ms at 16 kHz
    for offset in range(0, len(samples), chunk_size):
        stream.accept_waveform(16000, samples[offset:offset + chunk_size])
        while recognizer.is_ready(stream):
            recognizer.decode_stream(stream)
        partials.append({"audio_time_s": round(min(offset + chunk_size, len(samples)) / 16000, 3),
                         "text": recognizer.get_result(stream)})
    stream.accept_waveform(16000, np.zeros(16000, dtype=np.float32))
    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)
    elapsed = time.perf_counter() - start
    result = recognizer.get_result(stream)
    token_result = json.loads(recognizer.get_result_as_json_string(stream))
    duration = len(samples) / 16000
    output = {
        "candidate": f"{model.name} (native Python CPU)",
        "duration_s": round(duration, 3),
        "decode_elapsed_s": round(elapsed, 3),
        "real_time_factor": round(elapsed / duration, 3),
        "final_text": result,
        "token_result": token_result,
        "partials": partials,
        "limitations": "Single sample; no manual reference; native runtime, not browser WASM; not a Gate 0 pass.",
    }
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    wav_path.unlink()
    print(json.dumps({k: v for k, v in output.items() if k not in ("partials", "token_result")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

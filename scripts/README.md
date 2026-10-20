# llama.cpp Benchmark Results

## Summary

The deployed Qwen3.6-35B-A3B model sustained approximately **121 tokens/s at
short context** and **101 tokens/s at 60K input tokens**. Five measured text
requests completed at each tested context size. The llama pod remained Ready
with **zero restarts** after the tests.

These results establish a text-serving performance baseline, not answer quality
or safety under simultaneous speech/vision workloads. Only about **1.1 GiB GPU
memory remained** in observed snapshots.

## Environment

| Setting | Value |
| --- | --- |
| Run timestamps | October 20, 2026, starting 03:34:58 UTC; continuation at 03:39:22 UTC |
| Node | `k8s-talos-llm-4090`, Talos, Kubernetes v1.32.2 |
| GPU | One NVIDIA RTX 4090, 24,564 MiB reported VRAM |
| System RAM | Approximately 31.2 GiB |
| Server | llama.cpp `b11723-31288c9c6`, official `server-cuda` image |
| Model | Unsloth `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf` |
| Model revision | `a483e9e6cbd595906af30beda3187c2663a1118c` |
| GPU/offload | `--n-gpu-layers 99 --n-cpu-moe 8` |
| Context/slots | `--ctx-size 65536 --parallel 1` |
| Cache | Flash attention on, K and V both `q8_0` |
| Vision | `mmproj-F16.gguf` loaded; not exercised in these benchmark runs |
| CPU/RAM limits | 8 CPU cores, 22 GiB container RAM |
| Other workloads | Existing voice workloads left unchanged; no coordinated active-load test |

The machine's clock supplied the UTC timestamps above. The server image tag is
rolling; use the recorded build fingerprint when comparing later runs.

## Text Performance

Each row summarizes **five measured requests**, each generating **256 tokens**
with thinking disabled. Input is synthetic repeated inventory-service log text.

| Target Input | Actual Input Tokens | Median First Output | Slowest First Output | Median Total | Median Decode | Median Prefill |
| --- | --- | --- | --- | --- | --- | --- |
| 512 | 518-524 | 0.70 s | 1.30 s | 2.81 s | 121.1 tokens/s | 1,382 tokens/s |
| 4,096 | 4,103-4,108 | 2.02 s | 2.05 s | 4.15 s | 119.8 tokens/s | 2,318 tokens/s |
| 16,384 | 16,391-16,394 | 6.75 s | 6.78 s | 8.96 s | 115.7 tokens/s | 2,552 tokens/s |
| 32,768 | 32,775-32,778 | 13.43 s | 13.46 s | 15.75 s | 109.6 tokens/s | 2,522 tokens/s |
| 60,000 | 60,009-60,010 | 25.20 s | 25.25 s | 27.75 s | 101.0 tokens/s | 2,440 tokens/s |

First-output and total latency are measured client-side and include **kubectl
exec overhead**, so they are not direct application-to-NodePort latency.
Decode and prefill rates come from llama.cpp's server-side `timings`.
All recorded requests reported zero reused prompt tokens (`cache_n: 0`).

The first run was interrupted during the 32K group. Completed 512/4K/16K
groups were retained; 32K and 60K were measured in a separate completed run.
The table uses only the five-run completed groups, excluding four extra
32K samples from the interrupted run. The initial groups had two warmups each;
the continuation had no explicit warmups on an already-warm server.

## Thinking and Queueing

These are individual checks, not five-run statistical summaries.

### Thinking Enabled

For 4,105 input tokens and a fixed 1,024-token output:

- First reasoning/output token: **2.22 seconds**.
- Total request time: **10.75 seconds**.
- Decode throughput: **119.9 tokens/s**.
- No visible answer content was recorded within this output budget.

Reasoning counts toward the output budget. This check verifies streamed token
generation, not completion of a useful answer. Normal application requests
should not use `ignore_eos` and should provide a suitable reasoning budget.

### Two Simultaneous Requests

Each request had approximately 520 input tokens and generated 256 output tokens.

| Request | First Output | Total Time | Decode |
| --- | --- | --- | --- |
| Served first | 0.64 s | 2.75 s | 120.9 tokens/s |
| Served second | 3.22 s | 5.32 s | 121.3 tokens/s |

With one server slot, requests queued rather than decoding concurrently.
The later-served request waited approximately **2.58 seconds longer** for its
first output. Request launch order did not determine serving order.

## Memory and Health

Observed during a longer-context run:

- Whole-GPU usage: **22,989 MiB**, with **1,094 MiB free**.
- Container RAM: approximately **8.8 GiB current**, **8.9 GiB lifetime peak**.

After all tests:

- Whole-GPU usage: **22,991 MiB**, with **1,092 MiB free**.
- Container RAM: approximately **8.6 GiB current**, **9.0 GiB lifetime peak**.
- Pod: **1/1 Ready, zero restarts**; local `/health` returned `ok`.

GPU values are snapshots of the shared GPU, not measured peaks or llama-only
usage. The cgroup RAM peak covers the container's lifetime, not exclusively
these tests. No continuous memory sampling was performed.

## Reproduce

Requires local Node.js 18+, kubectl cluster access, and curl in the llama pod.

```bash
node scripts/benchmark-llama.mjs --thinking=true --queue=true --output=benchmark-results/llama-baseline.json
```

The continuation used for the 32K/60K rows and thinking/queue checks:

```bash
node scripts/benchmark-llama.mjs --contexts=32768,60000 --warmups=0 --repeats=5 --thinking=true --queue=true --output=benchmark-results/llama-long-context.json
```

Raw JSON reports are saved locally under `benchmark-results/` and ignored by Git.
See [benchmark-llama.md](benchmark-llama.md) for options and detailed methodology,
and [benchmark-llama.mjs](benchmark-llama.mjs) for the runner.

## Interpretation and Limits

- Short-context decode speed is consistently around 120 tokens/s. Long prompt
  processing dominates latency: a fresh 60K input took about 25 seconds before
  first output, despite sustaining around 101 tokens/s afterward.
- Five successful 60K-input requests provide evidence of near-limit text serving,
  not exhaustive validation of every request shape up to 65,536 total tokens.
- The benchmark forces fixed output length using `ignore_eos: true`, so a
  `length` finish reason is intentional, not evidence of a server failure.
- Synthetic repetitive logs are not a proxy for real coding/reasoning quality.
  Validate representative prompts separately.
- Five observations are too few for a reliable p95 estimate; the slowest observed
  first-output latency is reported instead.
- Video, large images, long-context vision, and simultaneous active speech GPU
  workloads were not benchmarked. The narrow VRAM margin warrants separate
  testing before treating those combinations as safe operating limits.
- No deployment settings or voice-agent resources were changed by these tests.
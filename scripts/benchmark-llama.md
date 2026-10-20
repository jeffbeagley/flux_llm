# llama.cpp HTTP Benchmark

Requires local Node.js 18+, kubectl access to the cluster, and curl in the
llama-server container. No packages or cluster resource changes are needed.
The runner does not modify or inspect voice-agent.

```bash
node scripts/benchmark-llama.mjs --thinking=true --queue=true
```

Defaults: approximately 512, 4096, 16384, 32768, and 60000 input tokens;
two warmups and five measured requests per size; 256 output tokens per request.
The final optional tests use one thinking-enabled request with a 1024-token
output budget and two simultaneous short requests to measure single-slot queueing.
Do not run alongside other LLM clients when measuring an isolated baseline.

For a quick check:

```bash
node scripts/benchmark-llama.mjs --contexts=512,4096 --tokens=128 --repeats=3 --warmups=1 --output=benchmark-results/quick.json
```

Additional options: `--namespace=vllm`, `--model=qwen3.6-35b-a3b`, and
`--timeout=600` (curl's per-request timeout in seconds).

Results are saved incrementally to `benchmark-results/llama.json` by default.
Generated result files are Git-ignored. Successful measured requests contribute
to the summary's median decode/prefill throughput and median/p95 first-output
latency. With only five samples, p95 is the slowest observed sample, not a robust
tail-latency estimate. Increase repetitions for meaningful tail statistics.

## Methodology

- Tokenize/detokenize endpoints construct synthetic repeated inventory logs near
  each target size. Actual prompt tokens, including nonce and chat template,
  are recorded in `usage.prompt_tokens`; targets are approximate.
- A unique nonce at the start of each prompt prevents cross-request prefix reuse.
  `cache_prompt=false` is also sent. Verify `timings.cache_n` is zero.
- `ignore_eos=true` forces a fixed output budget for fair decode comparisons.
  A `length` finish reason is expected here. Generated text is not a quality test
  and may continue beyond a natural stopping point.
- Thinking is disabled for baseline runs. The optional thinking test records
  first reasoning/output time separately from first visible answer content time.
  It can exhaust its budget before producing an answer; this is not a failure
  of the streaming transport.
- Client latency includes kubectl exec startup and streaming transport overhead.
  It does not measure direct network latency from an application to NodePort.
  Server `timings` measure prefill and decode separately from that overhead.
- Synthetic repeated logs are not representative of all code, prose, or documents.
  Compare like-for-like prompts and settings, and separately assess answer quality.
- Stop on a failed baseline request before increasing context. Partial measured
  results are retained. Test 60000 rather than 65536 input tokens to leave room
  for chat formatting and output within the 65536-token slot.

## Memory and Health

Capture these during a run and again afterward:

```bash
kubectl exec -n vllm deployment/llama-server -c llama-server -- nvidia-smi --query-gpu=memory.total,memory.used,memory.free,utilization.gpu --format=csv
kubectl exec -n vllm deployment/llama-server -c llama-server -- cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak
kubectl get pods -n vllm -l app=llama-server -o wide
```

GPU usage is a point-in-time snapshot for the whole shared GPU, not a sampled
peak or llama-only usage. The cgroup RAM peak is lifetime-to-date for that
container, not exclusively this benchmark. Resource metrics are not automatically
included in the JSON report.

This runner does not benchmark images/video or concurrent speech recognition.
Those require separate fixed media fixtures and coordinated workload tests;
passing the text matrix does not establish multimodal peak-memory safety.
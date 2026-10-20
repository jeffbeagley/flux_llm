# llama.cpp Serving and Migration

This directory deploys llama.cpp, not vLLM. The existing `vllm`
namespace and model-cache PV/PVC are retained to avoid a resource migration. Parakeet and Piper
are unchanged. The old Hugging Face cache is retained for rollback.

## Configuration

- Image: `ghcr.io/ggml-org/llama.cpp:server-cuda`, a rolling upstream image.
  `imagePullPolicy: Always` checks for updates whenever a pod starts.
- Model: Unsloth `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf`, with `mmproj-F16.gguf`
  to enable image/video input. Downloads are pinned to revision
  `a483e9e6cbd595906af30beda3187c2663a1118c`.
- Download size: approximately 21.5 GiB combined, stored under
  `/model-cache/llama/Qwen3.6-35B-A3B`. Temporary downloads are renamed only
  after success; existing completed files are reused.
- GPU layers: 99; expert weights for the first 8 layers stay on CPU.
- Context: 65,536 tokens with one request slot. A second request must wait;
  increasing `--parallel` changes per-slot context/memory requirements.
- Flash attention enabled, K and V caches both `q8_0`, Jinja tool templates enabled.
- API model name: `qwen3.6-35b-a3b`.
- External API: `http://172.16.8.36:30800/v1`.
- Internal API: `http://llama-server.vllm.svc.cluster.local/v1`.

Qwen3.6 follows the requested MoE GGUF configuration. Qwen3.8-27B is newer but
dense: `--n-cpu-moe` does not provide the same expert-offload path for it.

## Memory and Compatibility

The 24 GiB RTX 4090 is shared with Parakeet (about 3.2 GiB observed).
Four CPU expert layers failed during projector allocation on the live node.
Eight layers started successfully with a 64K slot and passed short chat,
tool-call, and image requests, with roughly 1.1 GiB VRAM remaining while
Parakeet was idle. Full-length prompts, video, and concurrent GPU workloads
have not been stress-tested. llama.cpp does not reserve a separate VRAM budget
for Parakeet. If CUDA allocation fails, increase `--n-cpu-moe` in
`llama-server.yaml` to 12 as needed. This trades GPU memory for CPU memory and latency.
Check pod events for `OOMKilled` separately from CUDA allocation failures.
Do not increase the 22 GiB container RAM limit without checking node headroom:
only about 31 GiB RAM is available in total, including Kubernetes and voice services.
If offload cannot meet both budgets, use a smaller quant/model or lower context.

The projector enables multimodal processing, but image/video payloads, tool calls,
reasoning output, and representative long prompts require live testing.
Vision introduces transient memory peaks; llama.cpp video handling is not
necessarily identical to the vLLM API. vLLM-specific parser flags are removed.

The cache PVC is 50 GiB. Check disk usage before rollout because old and new
models coexist on disk. The download init container runs as root to write the
existing hostPath cache; it does not request GPU access.

## First Migration

The old Helm router owns NodePort 30800. Remove it before creating the new
Service, and never run both inference engines together on this shared GPU.
The first download may exceed Flux's five-minute reconciliation timeout;
the download continues and a later reconciliation can succeed.

1. Suspend reconciliation before pushing this migration through normal GitOps:

   ```bash
   flux suspend kustomization infrastructure -n flux-system
   flux suspend helmrelease vllm -n vllm
   ```

2. Once the migration is pushed to the remote source, delete the suspended
  HelmRelease, then explicitly uninstall any remaining Helm release:

   ```bash
   kubectl delete helmrelease vllm -n vllm --wait=true --timeout=10m
   if helm status vllm-vllm -n vllm >/dev/null 2>&1; then
     helm uninstall vllm-vllm -n vllm --wait --timeout=5m
   fi
   kubectl get pods,services -n vllm
   ```

   Do not proceed until the old model pods and router Service have disappeared.
   Keep the separately managed cache PV/PVC.

  A suspended HelmRelease can be deleted without uninstalling its resources;
  verify that the actual Helm workload is gone, not just the HelmRelease object.

3. Resume Flux and reconcile the new resources:

   ```bash
   flux resume kustomization infrastructure -n flux-system
   flux reconcile kustomization infrastructure -n flux-system --with-source
   kubectl logs -n vllm deployment/llama-server -c download-model -f
   kubectl rollout status deployment/llama-server -n vllm --timeout=30m
   kubectl logs -n vllm deployment/llama-server -c llama-server --tail=100
   ```

4. Update clients using the old internal router DNS or old model identifier.
   The external node IP and NodePort remain unchanged. Verify the API:

   ```bash
   curl --fail http://172.16.8.36:30800/health
   curl --fail http://172.16.8.36:30800/v1/models
   curl --fail http://172.16.8.36:30800/v1/chat/completions \
     -H 'Content-Type: application/json' \
     -d '{"model":"qwen3.6-35b-a3b","messages":[{"role":"user","content":"Reply with OK"}],"max_tokens":128}'
   ```

   Test image/video input, tool calls, concurrent Parakeet transcription, and a
   representative 64K workload before considering migration complete.
   No API authentication is configured; keep this NodePort on a trusted network.

## Validation and Rollback

```bash
kubectl kustomize infrastructure/llama | kubectl apply --dry-run=client -f -
```

To roll back, suspend the infrastructure Kustomization, delete the llama-server
Deployment and Service, and wait for its pod to stop. Restore the old vLLM
manifests through Git before resuming reconciliation. This releases port 30800
and the GPU before Helm recreates vLLM. Restore client model names and internal
URLs as well; the old model cache remains available.

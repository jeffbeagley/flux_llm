# vLLM Manual Helm Install

Use these commands to install/upgrade vllm directly, bypassing Flux.

## Add Helm repo

```bash
helm repo add vllm https://vllm-project.github.io/production-stack
helm repo update
```

## Install / Upgrade

```bash
helm upgrade --install vllm vllm/vllm-stack \
  --version 0.1.12 \
  --namespace vllm \
  --create-namespace \
  --timeout 15m \
  --set routerSpec.serviceType=NodePort \
  --set routerSpec.nodePort=30800 \
  --set servingEngineSpec.startupProbe.initialDelaySeconds=30 \
  --set servingEngineSpec.startupProbe.periodSeconds=10 \
  --set servingEngineSpec.startupProbe.failureThreshold=60 \
  --set 'servingEngineSpec.modelSpec[0].name=qwen3-8-27b-awq' \
  --set servingEngineSpec.modelSpec[0].enabled=true \
  --set servingEngineSpec.modelSpec[0].runtimeClassName=nvidia \
  --set servingEngineSpec.modelSpec[0].repository=lmcache/vllm-openai \
  --set servingEngineSpec.modelSpec[0].tag=latest \
  --set servingEngineSpec.modelSpec[0].modelURL=cyankiwi/Qwen3.8-27B-AWQ-INT4 \
  --set servingEngineSpec.modelSpec[0].replicaCount=1 \
  --set servingEngineSpec.modelSpec[0].requestCPU=6 \
  --set 'servingEngineSpec.modelSpec[0].requestMemory=16Gi' \
  --set servingEngineSpec.modelSpec[0].requestGPU=1 \
  --set 'servingEngineSpec.modelSpec[0].requestGPUType=nvidia.com/gpu' \
  --set servingEngineSpec.modelSpec[0].limitCPU=8 \
  --set 'servingEngineSpec.modelSpec[0].limitMemory=32Gi' \
  --set 'servingEngineSpec.modelSpec[0].vllmConfig.extraArgs[0]=--quantization=awq' \
  --set 'servingEngineSpec.modelSpec[0].vllmConfig.extraArgs[1]=--dtype=auto' \
  --set 'servingEngineSpec.modelSpec[0].vllmConfig.extraArgs[2]=--max-model-len=4096' \
  --set 'servingEngineSpec.modelSpec[0].vllmConfig.extraArgs[3]=--max-num-seqs=1' \
  --set 'servingEngineSpec.modelSpec[0].vllmConfig.extraArgs[4]=--gpu-memory-utilization=0.95' \
  --set 'servingEngineSpec.modelSpec[0].vllmConfig.extraArgs[5]=--kv-cache-dtype=fp8' \
  --set 'servingEngineSpec.modelSpec[0].vllmConfig.extraArgs[6]=--enforce-eager'
```

> **Tip:** For iterative value changes, prefer a `values.yaml` override file and use `-f values-override.yaml` instead of many `--set` flags.

## Uninstall

```bash
helm uninstall vllm -n vllm
```

## Check status

```bash
helm status vllm -n vllm
kubectl get pods -n vllm
kubectl logs -n vllm -l app=vllm --follow
```

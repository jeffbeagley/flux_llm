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
  -f values.yaml
```

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

#!/usr/bin/env bash
# Sobe o 4Life do zero num cluster kind local:
#   cluster kind → cloud-provider-kind (Ingress/LoadBalancer) → metrics-server → imagens
#   → Secrets (do .env) → kubectl apply -k k8s/ → espera tudo ficar Ready.
set -euo pipefail
cd "$(dirname "$0")/.."
CLUSTER=4life
CPK_IMAGE=registry.k8s.io/cloud-provider-kind/cloud-controller-manager:v0.11.1
METRICS_SERVER=https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.8.0/components.yaml
IMAGENS=(doadores-service comunidades-service mobilizacoes-service informacoes-service bff-mobile bff-web gateway)
passo() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }

for bin in docker kind kubectl; do command -v $bin > /dev/null || { echo "Pré-requisito ausente: $bin" >&2; exit 1; }; done
[[ -f .env ]] || { echo "Crie o .env antes: ./scripts/gerar-env.sh" >&2; exit 1; }

passo "1/7 cluster kind"
if kind get clusters | grep -qx "$CLUSTER"; then echo "cluster '$CLUSTER' já existe"
else kind create cluster --config k8s/kind-config.yaml; fi
kubectl config use-context "kind-$CLUSTER" > /dev/null

passo "2/7 cloud-provider-kind (implementa Ingress e LoadBalancer no kind)"
if [[ -z $(docker ps -q -f name=^4life-cloud-provider-kind$) ]]; then
  docker rm -f 4life-cloud-provider-kind > /dev/null 2>&1 || true
  docker run -d --name 4life-cloud-provider-kind --restart unless-stopped --network kind \
    -v /var/run/docker.sock:/var/run/docker.sock "$CPK_IMAGE" > /dev/null
fi
echo "rodando: $(docker ps --format '{{.Names}} ({{.Status}})' -f name=^4life-cloud-provider-kind$)"

passo "3/7 metrics-server (para kubectl top e HPA)"
kubectl apply -f "$METRICS_SERVER" > /dev/null
# no kind os kubelets usam certificado autoassinado
kubectl -n kube-system patch deployment metrics-server --type=json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' > /dev/null 2>&1 || true
echo ok

passo "4/7 build das imagens e carga nos nós do kind"
docker compose build
for img in "${IMAGENS[@]}"; do kind load docker-image "4life/$img:1.0.0" --name "$CLUSTER" > /dev/null; echo "carregada: 4life/$img:1.0.0"; done

passo "5/7 Secrets (a partir do .env)"
./scripts/k8s-create-secrets.sh

passo "6/7 kubectl apply -k k8s/"
JA_EXISTIA=$(kubectl -n 4life get deployment gateway -o name 2>/dev/null || true)
kubectl apply -k k8s/
if [[ -n $JA_EXISTIA ]]; then
  # mesma tag (1.0.0) com imagem nova: força os pods a subirem de novo com a imagem recém-carregada
  kubectl -n 4life rollout restart deployment
fi

passo "7/7 aguardando tudo ficar Ready"
kubectl -n 4life rollout status statefulset --timeout=300s
kubectl -n 4life rollout status deployment --timeout=300s
kubectl -n 4life get pods -o wide

echo -n "aguardando IP do Ingress"
for _ in $(seq 1 60); do
  IP=$(kubectl -n 4life get ingress 4life -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
  [[ -n $IP ]] && break; echo -n "."; sleep 2
done
echo
[[ -n ${IP:-} ]] || { echo "Ingress sem IP ainda; confira: docker logs 4life-cloud-provider-kind" >&2; exit 1; }
cat <<MSG

Pronto! Ingress em $IP (host 4life.test). Teste com:
  curl --resolve 4life.test:80:$IP http://4life.test/health
  INGRESS_IP=$IP BASE_URL=http://4life.test ./scripts/smoke-test.sh
Opcional (navegador): echo "$IP 4life.test" | sudo tee -a /etc/hosts
MSG

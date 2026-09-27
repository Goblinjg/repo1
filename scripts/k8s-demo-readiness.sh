#!/usr/bin/env bash
# Liveness vs readiness na prática: derruba o banco do doadores-service e observa que
#   - READINESS falha → pods saem dos endpoints do Service (0/1), requisições dão 503;
#   - LIVENESS continua OK → o kubelet NÃO reinicia os pods (RESTARTS não muda).
# Ao voltar o banco, os pods voltam a Ready sozinhos.
set -euo pipefail
NS=4life
IP=$(kubectl -n $NS get ingress 4life -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
passo() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
estado() {
  kubectl -n $NS get pods -l app.kubernetes.io/name=doadores-service \
    -o custom-columns='POD:.metadata.name,READY:.status.containerStatuses[0].ready,RESTARTS:.status.containerStatuses[0].restartCount'
  printf '   endpoints prontos no Service: %s\n' \
    "$(kubectl -n $NS get endpointslices -l kubernetes.io/service-name=doadores-service -o jsonpath='{range .items[*].endpoints[?(@.conditions.ready==true)]}{.targetRef.name} {end}')"
  local codigos=()
  for _ in 1 2 3; do
    codigos+=("$(curl -s -o /dev/null -w '%{http_code}' --resolve 4life.test:80:$IP http://4life.test/api/web/cadastro \
      -H 'content-type: application/json' \
      -d '{"nome":"Teste Readiness","email":"readiness-'$RANDOM$RANDOM'@x.com","senha":"12345678","cidade":"Lavras","uf":"MG"}')")
  done
  echo "   3 cadastros seguidos → HTTP ${codigos[*]}"
}

passo "Antes: banco no ar"
estado

passo "kubectl scale statefulset/doadores-db --replicas=0 (banco fora do ar)"
kubectl -n $NS scale statefulset/doadores-db --replicas=0
kubectl -n $NS wait --for=delete pod/doadores-db-0 --timeout=60s
echo "   aguardando a readiness falhar (período 5s × 2 falhas)..."
kubectl -n $NS wait --for=condition=Ready=false pod -l app.kubernetes.io/name=doadores-service --timeout=60s > /dev/null
estado
echo "   → pods Running, porém NÃO Ready; RESTARTS igual: liveness (/health) segue OK, ninguém é reiniciado."
echo "   → 503 = o BFF não encontra nenhum pod pronto atrás do Service doadores-service."
echo "     (um 502 isolado pode aparecer: requisição que ainda usava uma conexão keep-alive antiga,"
echo "      que o serviço fecha com 'Connection: close' por não estar pronto)"

passo "kubectl scale statefulset/doadores-db --replicas=1 (banco volta)"
kubectl -n $NS scale statefulset/doadores-db --replicas=1
kubectl -n $NS wait --for=condition=Ready pod/doadores-db-0 --timeout=120s > /dev/null
kubectl -n $NS wait --for=condition=Ready pod -l app.kubernetes.io/name=doadores-service --timeout=120s > /dev/null
estado

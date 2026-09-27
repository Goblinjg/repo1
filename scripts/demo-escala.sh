#!/usr/bin/env bash
# Demonstração de escalabilidade horizontal do mobilizacoes-service:
#   1 réplica → carga → distribuição;  kubectl scale → 3 réplicas → carga → distribuição.
# As requisições entram pelo Ingress e percorrem Ingress → gateway → bff-mobile → mobilizacoes;
# GET /api/mobile/diagnostico/whoami devolve o nome do pod do mobilizacoes que atendeu.
set -euo pipefail
NS=4life
DEPLOY=mobilizacoes-service
N=${N:-300}            # requisições por rodada
PARALELO=${PARALELO:-20}
IP=$(kubectl -n $NS get ingress 4life -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
URL=http://4life.test/api/mobile/diagnostico/whoami
passo() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }

carga() {
  passo "Disparando $N requisições ($PARALELO em paralelo) pelo Ingress"
  local inicio fim
  inicio=$(date +%s.%N)
  seq "$N" | xargs -P "$PARALELO" -I{} \
    curl -s --resolve "4life.test:80:$IP" "$URL" -o - -w '\n' \
    | jq -r '.mobilizacoes // "ERRO"' | sort | uniq -c | sort -rn \
    | awk -v n="$N" '{ printf "   %-45s %4d req  %5.1f%%  ", $2, $1, 100*$1/n; for (i=0; i<$1*40/n; i++) printf "█"; print "" }'
  fim=$(date +%s.%N)
  awk -v a="$inicio" -v b="$fim" -v n="$N" 'BEGIN { printf "   %d req em %.2fs (%.0f req/s)\n", n, b-a, n/(b-a) }'
}

passo "Estado inicial"
kubectl -n $NS scale deployment/$DEPLOY --replicas=1 > /dev/null
kubectl -n $NS rollout status deployment/$DEPLOY --timeout=120s > /dev/null
kubectl -n $NS get pods -l app.kubernetes.io/name=$DEPLOY -o wide
carga

passo "kubectl scale deployment/$DEPLOY --replicas=3"
kubectl -n $NS scale deployment/$DEPLOY --replicas=3
kubectl -n $NS rollout status deployment/$DEPLOY --timeout=120s
# Pod Ready ≠ tráfego imediato: o kube-proxy de CADA nó precisa reprogramar as regras do Service.
# Sem essa pausa, a primeira rodada favorece os pods antigos (medido: 49%/45%/6%).
echo "   aguardando 5s para os endpoints propagarem para o kube-proxy de todos os nós..."
sleep 5
kubectl -n $NS get pods -l app.kubernetes.io/name=$DEPLOY -o wide
echo "   endpoints do Service (só pods Ready entram):"
kubectl -n $NS get endpointslices -l kubernetes.io/service-name=$DEPLOY \
  -o jsonpath='{range .items[*].endpoints[*]}      {.addresses[0]}  {.targetRef.name}  ready={.conditions.ready}{"\n"}{end}'
carga

if [[ ${VOLTAR:-1} == 1 ]]; then
  passo "Voltando para 1 réplica (VOLTAR=0 para manter 3)"
  kubectl -n $NS scale deployment/$DEPLOY --replicas=1
fi

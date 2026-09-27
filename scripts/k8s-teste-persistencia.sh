#!/usr/bin/env bash
# O que acontece com o dado se o pod do banco morrer?
#   1. cadastra um doador;  2. mata o pod doadores-db-0;  3. o StatefulSet recria o pod
#   (mesmo nome) e ele monta o MESMO PVC;  4. login com o doador funciona.
set -euo pipefail
NS=4life
IP=$(kubectl -n $NS get ingress 4life -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
C=(curl -sf --resolve "4life.test:80:$IP")
EMAIL="k8s-persistencia-$(date +%s)@4life.local"; SENHA="persistencia-123"
passo() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }

passo "1. cadastrando $EMAIL"
"${C[@]}" http://4life.test/api/web/cadastro -H 'content-type: application/json' \
  -d "{\"nome\":\"Teste K8s\",\"email\":\"$EMAIL\",\"senha\":\"$SENHA\",\"cidade\":\"Lavras\",\"uf\":\"MG\"}" | jq -c '{id, email}'
kubectl -n $NS get pvc -l app.kubernetes.io/name=doadores-db
UID_ANTES=$(kubectl -n $NS get pod doadores-db-0 -o jsonpath='{.metadata.uid}')

passo "2. kubectl delete pod doadores-db-0 (simulando a morte do pod)"
kubectl -n $NS delete pod doadores-db-0 --wait=false
kubectl -n $NS get pods -l app.kubernetes.io/name=doadores-db

passo "3. aguardando o StatefulSet recriar o pod"
kubectl -n $NS wait --for=condition=Ready pod/doadores-db-0 --timeout=120s
kubectl -n $NS wait --for=condition=Ready pod -l app.kubernetes.io/name=doadores-service --timeout=120s
echo "   pod novo (uid $(kubectl -n $NS get pod doadores-db-0 -o jsonpath='{.metadata.uid}' | cut -c1-8)…, antes ${UID_ANTES:0:8}…), mesmo PVC:"
kubectl -n $NS get pod doadores-db-0 -o jsonpath='   volume dados → PVC {.spec.volumes[?(@.name=="dados")].persistentVolumeClaim.claimName}{"\n"}'

passo "4. login com o doador cadastrado antes da morte do pod"
# Logo após o banco voltar, conexões antigas do pool do serviço podem falhar uma vez; por isso
# tentamos algumas vezes e mostramos quantas foram necessárias.
for tentativa in $(seq 1 15); do
  if RESP=$("${C[@]}" http://4life.test/auth/login -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"senha\":\"$SENHA\"}"); then
    echo "$RESP" | jq -r --arg t "$tentativa" '"   login OK na tentativa \($t), token: " + .token[0:25] + "..."'
    break
  fi
  [[ $tentativa == 15 ]] && { echo "   login falhou após 15 tentativas" >&2; exit 1; }
  sleep 1
done
echo "== o dado sobreviveu: está no PersistentVolume, não no container ✔"

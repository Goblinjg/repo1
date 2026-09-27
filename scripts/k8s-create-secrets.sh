#!/usr/bin/env bash
# Cria/atualiza os Secrets do namespace 4life a partir do .env (que não é versionado).
# Idempotente: usa `kubectl create --dry-run=client -o yaml | kubectl apply -f -`.
set -euo pipefail
cd "$(dirname "$0")/.."
NS=4life
ENV_FILE="${1:-.env}"
[[ -f $ENV_FILE ]] || { echo "Arquivo $ENV_FILE não encontrado. Rode ./scripts/gerar-env.sh" >&2; exit 1; }

# Lê KEY=VALUE sem executar o arquivo (evita interpretar conteúdo como shell).
valor() {
  local v
  v=$(grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-)
  [[ -n $v ]] || { echo "Variável $1 ausente em $ENV_FILE" >&2; exit 1; }
  printf '%s' "$v"
}

aplicar() { kubectl create secret generic "$@" -n "$NS" --dry-run=client -o yaml | kubectl apply -f - ; }

kubectl get namespace "$NS" > /dev/null 2>&1 || kubectl create namespace "$NS"

aplicar doadores-db-credentials     --from-literal=password="$(valor DOADORES_DB_PASSWORD)"
aplicar comunidades-db-credentials  --from-literal=password="$(valor COMUNIDADES_DB_PASSWORD)"
aplicar mobilizacoes-db-credentials --from-literal=password="$(valor MOBILIZACOES_DB_PASSWORD)"
aplicar informacoes-db-credentials  --from-literal=password="$(valor INFORMACOES_DB_PASSWORD)"
aplicar rabbitmq-credentials        --from-literal=username="$(valor RABBITMQ_USER)" \
                                    --from-literal=password="$(valor RABBITMQ_PASSWORD)"
aplicar gateway-jwt                 --from-literal=JWT_SECRET="$(valor JWT_SECRET)"

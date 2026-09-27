#!/usr/bin/env bash
# Demonstra que os volumes nomeados preservam os dados quando os containers são destruídos.
#   1. cadastra um doador;  2. `docker compose down` (remove containers e redes, mantém volumes);
#   3. `docker compose up -d`;  4. faz login com o mesmo doador.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE="http://localhost:${GATEWAY_PORT:-8080}"
EMAIL="persistencia-$(date +%s)@4life.local"; SENHA="persistencia-123"

esperar_saudavel() {
  local total; total=$(docker compose config --services | wc -l)
  for _ in $(seq 1 90); do
    [[ $(docker compose ps --format '{{.Health}}' | grep -c '^healthy$') == "$total" ]] && return 0
    sleep 2
  done
  echo "timeout esperando os containers ficarem healthy" >&2; return 1
}

echo "== 1. cadastrando $EMAIL"
curl -sf "$BASE/api/web/cadastro" -H 'content-type: application/json' \
  -d "{\"nome\":\"Teste Persistência\",\"email\":\"$EMAIL\",\"senha\":\"$SENHA\",\"cidade\":\"Lavras\",\"uf\":\"MG\"}" | jq -c '{id, email}'

echo "== 2. docker compose down (sem -v: volumes são mantidos)"
docker compose down 2>&1 | grep -E 'Removed|Removing' | tail -3
echo "   containers do projeto agora: $(docker compose ps -q | wc -l)"
docker volume ls --filter name=4life_ --format '   volume: {{.Name}}'

echo "== 3. docker compose up -d"
docker compose up -d > /dev/null 2>&1
esperar_saudavel && echo "   todos os containers healthy"

echo "== 4. login com o doador cadastrado antes do down"
curl -sf "$BASE/auth/login" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"senha\":\"$SENHA\"}" \
  | jq -r '"   login OK, token: " + (.token[0:25]) + "..."'
echo "== dado persistiu no volume 4life_doadores-db-data ✔"
echo "(para apagar TUDO, inclusive os dados: docker compose down -v)"

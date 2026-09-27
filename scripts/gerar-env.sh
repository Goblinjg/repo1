#!/usr/bin/env bash
# Gera um .env com segredos aleatórios a partir do .env.example.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env && "${1:-}" != "--force" ]]; then
  echo ".env já existe (use --force para sobrescrever)." >&2
  exit 1
fi

aleatorio() { openssl rand -hex "$1"; }

sed -e "s/^\(DOADORES_DB_PASSWORD\)=.*/\1=$(aleatorio 16)/" \
    -e "s/^\(COMUNIDADES_DB_PASSWORD\)=.*/\1=$(aleatorio 16)/" \
    -e "s/^\(MOBILIZACOES_DB_PASSWORD\)=.*/\1=$(aleatorio 16)/" \
    -e "s/^\(INFORMACOES_DB_PASSWORD\)=.*/\1=$(aleatorio 16)/" \
    -e "s/^\(RABBITMQ_PASSWORD\)=.*/\1=$(aleatorio 16)/" \
    -e "s/^\(JWT_SECRET\)=.*/\1=$(aleatorio 32)/" \
    .env.example > .env
chmod 600 .env
echo ".env gerado com segredos aleatórios."

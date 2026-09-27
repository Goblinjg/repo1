#!/usr/bin/env bash
# Mede o ganho do multi-stage: constrói cada componente também com docker/Dockerfile.single-stage
# (node:22 completo, sem multi-stage) e compara os tamanhos reportados por `docker images`.
set -euo pipefail
export LC_ALL=C
cd "$(dirname "$0")/.."
COMPONENTES=(services/doadores-service services/comunidades-service services/mobilizacoes-service
             services/informacoes-service bff/bff-mobile bff/bff-web gateway)

# No Docker 29 (containerd image store), `docker images` mostra duas colunas:
#   CONTENT SIZE = camadas comprimidas (o que é baixado do registry)
#   DISK USAGE   = conteúdo + camadas descompactadas (o que ocupa no disco)
conteudo() { docker image inspect "$1" --format '{{.Size}}' | awk '{printf "%.0f", $1/1000/1000}'; }
disco()    { docker images "$1" --format '{{.Size}}' | sed 's/B$//' | numfmt --from=si | awk '{printf "%.0f", $1/1000/1000}'; }

printf '| %-22s | %-24s | %-24s |\n' "Imagem" "CONTENT SIZE (antes → depois)" "DISK USAGE (antes → depois)"
printf '|%s|%s|%s|\n' "------------------------" "-------------------------------" "------------------------------"
for dir in "${COMPONENTES[@]}"; do
  nome=$(basename "$dir")
  docker build -q -f docker/Dockerfile.single-stage -t "4life/$nome:single-stage" "$dir" > /dev/null
  docker build -q -t "4life/$nome:1.0.0" "$dir" > /dev/null
  a=$(conteudo "4life/$nome:single-stage"); d=$(conteudo "4life/$nome:1.0.0")
  da=$(disco "4life/$nome:single-stage"); dd=$(disco "4life/$nome:1.0.0")
  printf '| %-22s | %4s MB → %3s MB (-%s%%)       | %5s MB → %3s MB (-%s%%)      |\n' \
    "$nome" "$a" "$d" "$(( (a - d) * 100 / a ))" "$da" "$dd" "$(( (da - dd) * 100 / da ))"
done
echo
docker images | grep -E '^(IMAGE|4life/)'

#!/usr/bin/env bash
# Demonstra o isolamento de redes do docker compose.
# Cada teste abre uma conexão TCP de DENTRO de um container para um alvo.
# Esperado: só conecta quem compartilha uma rede com o alvo.
set -uo pipefail
cd "$(dirname "$0")/.."

tentar() { # origem destino porta
  docker compose exec -T "$1" node -e "
    const s = require('net').connect({ host: '$2', port: $3, timeout: 3000 });
    s.on('connect', () => { console.log('CONECTOU'); process.exit(0); });
    s.on('timeout', () => { console.log('FALHOU (timeout)'); process.exit(1); });
    s.on('error', (e) => { console.log('FALHOU (' + e.code + ')'); process.exit(1); });" 2>&1
}

passou=0; falhou=0
caso() { # descricao esperado(conecta|bloqueado) origem destino porta
  local resultado; resultado=$(tentar "$3" "$4" "$5")
  local obtido
  case $resultado in
    CONECTOU) obtido=conecta ;;
    FALHOU*)  obtido=bloqueado ;;
    *)        obtido="erro no teste" ;;   # ex.: container parado — não conta como bloqueio
  esac
  if [[ $obtido == "$2" ]]; then
    printf '  \033[32m✔\033[0m %-58s %s\n' "$1" "$resultado"; passou=$((passou + 1))
  else
    printf '  \033[31m✘\033[0m %-58s %s (esperado: %s)\n' "$1" "$resultado" "$2"; falhou=$((falhou + 1))
  fi
}

echo "== Acessos permitidos"
caso "doadores-service → doadores-db:5432 (próprio banco)"        conecta   doadores-service     doadores-db 5432
caso "mobilizacoes-service → rabbitmq:5672"                       conecta   mobilizacoes-service rabbitmq 5672
caso "bff-web → comunidades-service:3002"                         conecta   bff-web              comunidades-service 3002
caso "gateway → bff-mobile:4001"                                  conecta   gateway              bff-mobile 4001

echo "== Acessos bloqueados pelo isolamento de redes"
caso "doadores-service → comunidades-db:5432 (banco ALHEIO)"      bloqueado doadores-service     comunidades-db 5432
caso "mobilizacoes-service → doadores-db:5432 (banco ALHEIO)"     bloqueado mobilizacoes-service doadores-db 5432
caso "bff-web → doadores-db:5432 (BFF não acessa banco)"          bloqueado bff-web              doadores-db 5432
caso "gateway → doadores-service:3001 (gateway só vê BFFs)"       bloqueado gateway              doadores-service 3001
caso "informacoes-service → rabbitmq:5672 (fora da rede bus)"     bloqueado informacoes-service  rabbitmq 5672

# Mesmo sabendo o IP (sem depender de DNS), não há rota entre redes diferentes.
IP_COM_DB=$(docker inspect "$(docker compose ps -q comunidades-db)" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
caso "doadores-service → $IP_COM_DB:5432 (IP do comunidades-db)"  bloqueado doadores-service     "$IP_COM_DB" 5432

echo "== $passou ok, $falhou divergente(s)"
[[ $falhou -eq 0 ]]

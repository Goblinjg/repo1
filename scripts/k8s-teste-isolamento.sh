#!/usr/bin/env bash
# Demonstra as NetworkPolicies no cluster: abre conexões TCP de DENTRO dos pods.
# Equivalente K8s de scripts/teste-isolamento.sh (redes do compose).
set -uo pipefail
NS=4life

tentar() { # deployment|pod-origem host porta
  kubectl -n $NS exec "$1" -- node -e "
    const s = require('net').connect({ host: '$2', port: $3, timeout: 3000 });
    s.on('connect', () => { console.log('CONECTOU'); process.exit(0); });
    s.on('timeout', () => { console.log('FALHOU (timeout)'); process.exit(1); });
    s.on('error', (e) => { console.log('FALHOU (' + e.code + ')'); process.exit(1); });" 2>&1 | head -1
}

passou=0; falhou=0
caso() { # descricao esperado origem host porta
  local resultado obtido; resultado=$(tentar "$3" "$4" "$5")
  case $resultado in CONECTOU) obtido=conecta ;; FALHOU*) obtido=bloqueado ;; *) obtido="erro no teste" ;; esac
  if [[ $obtido == "$2" ]]; then printf '  \033[32m✔\033[0m %-60s %s\n' "$1" "$resultado"; passou=$((passou + 1))
  else printf '  \033[31m✘\033[0m %-60s %s (esperado: %s)\n' "$1" "$resultado" "$2"; falhou=$((falhou + 1)); fi
}

echo "== NetworkPolicies no namespace $NS"
kubectl -n $NS get networkpolicy --no-headers | awk '{print "   " $1}'

echo "== Acessos permitidos"
caso "doadores-service → doadores-db:5432 (próprio banco)"      conecta   deploy/doadores-service     doadores-db 5432
caso "mobilizacoes-service → rabbitmq:5672"                     conecta   deploy/mobilizacoes-service rabbitmq 5672
caso "bff-web → comunidades-service:3002"                       conecta   deploy/bff-web              comunidades-service 3002
caso "gateway → bff-mobile:4001"                                conecta   deploy/gateway              bff-mobile 4001

echo "== Acessos bloqueados"
caso "doadores-service → comunidades-db:5432 (banco ALHEIO)"    bloqueado deploy/doadores-service     comunidades-db 5432
caso "mobilizacoes-service → doadores-db:5432 (banco ALHEIO)"   bloqueado deploy/mobilizacoes-service doadores-db 5432
caso "bff-web → doadores-db:5432 (BFF não acessa banco)"        bloqueado deploy/bff-web              doadores-db 5432
caso "gateway → doadores-service:3001 (gateway só vê BFFs)"     bloqueado deploy/gateway              doadores-service 3001
caso "informacoes-service → rabbitmq:5672"                      bloqueado deploy/informacoes-service  rabbitmq 5672

echo "== $passou ok, $falhou divergente(s)"
[[ $falhou -eq 0 ]]

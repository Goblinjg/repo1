#!/usr/bin/env bash
# Roteiro AO VIVO da Parte 4 (6.1 e 6.2), tudo pelo gateway:
#   1. fluxo ponta a ponta (gateway → BFF → serviços)
#   2. SAGA: caminho feliz
#   3. SAGA: falha provocada com compensação (hemocentro sem capacidade → C2 → C1)
#   4. SAGA: timeout provocado derrubando o informacoes-service (opcional)
#   5. CQRS: escrita refletida no modelo de leitura
#   6. bancos separados por serviço
#   7. LLM: RAG + tool, cache e fallback com o Ollama fora (opcional)
#
# Uso: ./scripts/demo-parte4.sh                                         (docker compose)
#      MODO=k8s INGRESS_IP=<ip> ./scripts/demo-parte4.sh                (Kubernetes; BASE_URL=http://4life.test)
#      SEM_PAUSA=1 ./scripts/demo-parte4.sh                             (sem esperar Enter entre as etapas)
set -euo pipefail
cd "$(dirname "$0")/.."
MODO="${MODO:-compose}"
if [[ $MODO == k8s ]]; then BASE="${BASE_URL:-http://4life.test}"; else BASE="${BASE_URL:-http://localhost:8080}"; fi
RESOLVE=()
if [[ -n ${INGRESS_IP:-} ]]; then HOST=${BASE#*://}; HOST=${HOST%%/*}; RESOLVE=(--resolve "${HOST}:80:${INGRESS_IP}"); fi

titulo() { printf '\n\033[1;35m━━ %s\033[0m\n' "$*"; }
passo()  { printf '\033[1;34m▸ %s\033[0m\n' "$*"; }
info()   { printf '  %s\n' "$*"; }
pausa()  { [[ -n ${SEM_PAUSA:-} ]] || read -rp $'\n  [Enter para continuar] ' _; }
pergunta_sn() { [[ -n ${SEM_PAUSA:-} ]] && return 1; read -rp "  $1 [s/N] " r; [[ $r == [sS] ]]; }
api()    { curl -sS "${RESOLVE[@]}" "$@"; }
json()   { api -H 'content-type: application/json' "$@"; }

# parar/iniciar um componente (compose ou k8s)
parar() {
  if [[ $MODO == k8s ]]; then kubectl -n 4life scale deployment "$1" --replicas=0 > /dev/null
  else docker compose stop "$1" > /dev/null 2>&1; fi
}
iniciar() {
  if [[ $MODO == k8s ]]; then kubectl -n 4life scale deployment "$1" --replicas="${2:-1}" > /dev/null; kubectl -n 4life rollout status deployment "$1" --timeout=120s > /dev/null
  else docker compose start "$1" > /dev/null 2>&1; fi
}
psql_em() { # banco comando
  if [[ $MODO == k8s ]]; then kubectl -n 4life exec "$1-db-0" -- psql -U "$1" -d "$1" -c "$2"
  else docker compose exec -T "$1-db" psql -U "$1" -d "$1" -c "$2"; fi
}

saga() { # mobilizacaoId → espera terminar e mostra a linha do tempo
  local estado
  for _ in $(seq 1 120); do
    estado=$(api "$BASE/api/web/mobilizacoes/$1/saga" -H "$AUTH" | jq -r .estado)
    [[ $estado == CONCLUIDA || $estado == COMPENSADA || $estado == FALHOU ]] && break
    sleep 0.5
  done
  api "$BASE/api/web/mobilizacoes/$1/saga" -H "$AUTH" | jq -r '"  saga \(.estado)", (.historico[] | "    \(.em[11:23])  \(.etapa | . + "          " | .[0:11]) \(.descricao)")'
  api "$BASE/api/web/mobilizacoes/$1" -H "$AUTH" | jq -r '"  mobilização: \(.estado)\(if .motivoCancelamento then " — " + .motivoCancelamento else "" end)"'
}

HEMO_LAVRAS=33333333-3333-4333-8333-333333333331   # capacidade: 1 mobilização por dia
DIA=$(date -d "+$((60 + RANDOM % 1000)) days" +%Y-%m-%d)

titulo "1. Fluxo ponta a ponta: cliente → Ingress/gateway → BFF → serviços de domínio ($MODO, $BASE)"
EMAIL="demo-$(date +%s)@4life.local"
passo "cadastro (POST /api/web/cadastro → bff-web → doadores-service)"
json "$BASE/api/web/cadastro" -d "{\"nome\":\"Demo Parte 4\",\"email\":\"$EMAIL\",\"senha\":\"senha-demo-123\",\"cidade\":\"Lavras\",\"uf\":\"MG\",\"tipoSanguineo\":\"O-\"}" | jq -c '{id, nome, email}'
passo "login (POST /auth/login → gateway assina o JWT)"
TOKEN=$(json "$BASE/auth/login" -d "{\"email\":\"$EMAIL\",\"senha\":\"senha-demo-123\"}" | jq -r .token)
AUTH="authorization: Bearer $TOKEN"; info "token: ${TOKEN:0:32}…"
passo "criar comunidade (bff-web → comunidades-service; quem cria vira admin)"
COM_A=$(json "$BASE/api/web/comunidades" -H "$AUTH" -d '{"nome":"Doadores da Demo","cidade":"Lavras","uf":"MG"}' | jq -r .id)
COM_B=$(json "$BASE/api/web/comunidades" -H "$AUTH" -d '{"nome":"Outra Comunidade da Demo","cidade":"Lavras","uf":"MG"}' | jq -r .id)
info "comunidades: $COM_A e $COM_B"
pausa

titulo "2. SAGA orquestrada — caminho feliz (T1 → T2 → T3 → T4)"
passo "POST /api/web/comunidades/{id}/mobilizacoes em $DIA no ponto de coleta de Lavras"
R=$(json "$BASE/api/web/comunidades/$COM_A/mobilizacoes" -H "$AUTH" -w '\n%{http_code}' \
  -d "{\"titulo\":\"Mobilização feliz\",\"dataHora\":\"${DIA}T09:00:00-03:00\",\"hemocentroId\":\"$HEMO_LAVRAS\",\"vagas\":10}")
info "HTTP $(tail -1 <<< "$R") — $(head -1 <<< "$R" | jq -c '{estado, sagaId, _links}')"
MOB_OK=$(head -1 <<< "$R" | jq -r .id)
saga "$MOB_OK"
pausa

titulo "3. SAGA — FALHA PROVOCADA com compensação (hemocentro sem capacidade)"
info "Outra comunidade pede o MESMO hemocentro no MESMO dia. Lavras atende 1 mobilização por dia:"
info "T2 (reservar data) dá certo, T3 (reservar janela) é recusado → C2 libera a data → C1 cancela."
MOB_FALHA=$(json "$BASE/api/web/comunidades/$COM_B/mobilizacoes" -H "$AUTH" \
  -d "{\"titulo\":\"Mobilização sem capacidade\",\"dataHora\":\"${DIA}T14:00:00-03:00\",\"hemocentroId\":\"$HEMO_LAVRAS\"}" | jq -r .id)
saga "$MOB_FALHA"
passo "prova da compensação nos bancos (reservas do dia $DIA)"
psql_em comunidades "SELECT comunidade_id, data, saga_id FROM reservas_calendario WHERE data = '$DIA'"
psql_em informacoes "SELECT hemocentro_id, data, saga_id FROM reservas_hemocentro WHERE data = '$DIA'"
info "→ só sobrou a reserva da mobilização feliz; a da comunidade B foi desfeita pelo C2."
pausa

titulo "4. SAGA — timeout provocado (informacoes-service fora do ar)"
if pergunta_sn "Derrubar o informacoes-service agora e esperar o timeout da saga (~30 s)?"; then
  parar informacoes-service; info "informacoes-service PARADO"
  DIA2=$(date -d "$DIA +1 day" +%Y-%m-%d)
  MOB_TO=$(json "$BASE/api/web/comunidades/$COM_A/mobilizacoes" -H "$AUTH" \
    -d "{\"titulo\":\"Mobilização com timeout\",\"dataHora\":\"${DIA2}T09:00:00-03:00\",\"hemocentroId\":\"$HEMO_LAVRAS\"}" | jq -r .id)
  info "mobilização criada; aguardando o prazo do passo T3…"; sleep 33
  api "$BASE/api/web/mobilizacoes/$MOB_TO/saga" -H "$AUTH" | jq -r '"  saga \(.estado), compensações pendentes: \(.compensacoesPendentes | join(" → "))"'
  passo "religando o informacoes-service: ele processa a fila (reserva + C3) e a saga termina a compensação"
  iniciar informacoes-service 2
  saga "$MOB_TO"
fi
pausa

titulo "5. CQRS — painel da comunidade (modelo de leitura) refletindo uma escrita"
passo "GET /api/web/comunidades/{id} lê o documento pronto da projeção (1 consulta, sem N+1)"
api "$BASE/api/web/comunidades/$COM_A" -H "$AUTH" | jq -c '{fonte, versao, atualizadoEm, totalMembros, membros: [.membros[].nome], totalMobilizacoes, proximas: [.proximasMobilizacoes[].titulo]}'
passo "ESCRITA: um novo doador entra na comunidade (modelo normalizado + evento na outbox)"
E2="membro-$(date +%s)@4life.local"
json "$BASE/api/web/cadastro" -d "{\"nome\":\"Nova Integrante\",\"email\":\"$E2\",\"senha\":\"senha-demo-123\",\"cidade\":\"Lavras\",\"uf\":\"MG\"}" > /dev/null
T2=$(json "$BASE/auth/login" -d "{\"email\":\"$E2\",\"senha\":\"senha-demo-123\"}" | jq -r .token)
api -X POST "$BASE/api/mobile/comunidades/$COM_A/entrar" -H "authorization: Bearer $T2" -o /dev/null -w '  POST /entrar → %{http_code}\n'
passo "leitura imediata (pode ainda estar na versão anterior: consistência eventual)"
api "$BASE/api/web/comunidades/$COM_A" -H "$AUTH" | jq -c '{versao, totalMembros, membros: [.membros[].nome]}'
sleep 1.5
passo "leitura 1,5 s depois (projeção atualizada pelo evento membro.entrou)"
api "$BASE/api/web/comunidades/$COM_A" -H "$AUTH" | jq -c '{versao, atualizadoEm, totalMembros, membros: [.membros[].nome]}'
pausa

titulo "6. Database per service — cada serviço com o seu banco"
for s in doadores comunidades mobilizacoes informacoes; do
  passo "$s-db"
  psql_em "$s" "SELECT string_agg(tablename, ', ' ORDER BY tablename) AS tabelas FROM pg_tables WHERE schemaname = 'public'" | sed -n 3p
done
info "isolamento de rede: ./scripts/$([[ $MODO == k8s ]] && echo k8s-)teste-isolamento.sh"
pausa

titulo "7. LLM — assistente com RAG + tool (LangChain + Ollama)"
perguntar() {
  local r; r=$(json "$BASE/api/web/assistente/perguntar" -H "$AUTH" -d "$1" -w '\n%{http_code}')
  if ! head -n -1 <<< "$r" | jq -e . > /dev/null 2>&1; then info "HTTP $(tail -1 <<< "$r"): $(head -n -1 <<< "$r" | head -c 200)"; return; fi
  head -n -1 <<< "$r" | jq -c '{origem, duracaoMs, resposta, fontes: [.fontes[] | "\(.titulo) (\(.similaridade))"], ferramentas: [.ferramentas[] | "\(.nome) \(.argumentos | tostring)"], aviso}'
}
passo "pergunta respondida pela base de conhecimento (RAG)"
perguntar '{"pergunta":"Fiz uma tatuagem, quanto tempo preciso esperar para doar sangue?"}'
passo "a MESMA pergunta sem recuperação (linha de base)"
perguntar '{"pergunta":"Fiz uma tatuagem, quanto tempo preciso esperar para doar sangue?","usarRag":false,"usarCache":false}'
passo "pergunta que exige DADOS REAIS do sistema → o modelo chama uma tool"
perguntar "{\"pergunta\":\"O hemocentro de Lavras tem vaga para mobilização no dia $DIA?\"}"
passo "repetindo a primeira pergunta → cache"
perguntar '{"pergunta":"Fiz uma tatuagem, quanto tempo preciso esperar para doar sangue?"}'
if pergunta_sn "Derrubar o Ollama para mostrar timeout/retry → circuit breaker → fallback?"; then
  parar ollama; info "Ollama PARADO"
  for q in "Posso doar depois de tomar vacina?" "Quanto tempo depois de uma cirurgia posso doar?" "Quem tem piercing pode doar?" "Qual o horário do hemocentro de Varginha?"; do
    perguntar "{\"pergunta\":\"$q\"}"
    api "$BASE/api/web/info/assistente/status" | jq -c '{circuitos: (.circuitos | map_values(.estado))}'
  done
  iniciar ollama; info "Ollama religado (o circuito testa de novo depois de 30 s e fecha se o provedor responder)"
fi

titulo "Fim da demonstração"

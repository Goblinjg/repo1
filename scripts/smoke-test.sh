#!/usr/bin/env bash
# Teste ponta a ponta pelo gateway: cadastro → login → comunidade → mobilização (SAGA) → evento → painel (CQRS) → assistente.
# Uso: ./scripts/smoke-test.sh                                                  (compose, padrão)
#      INGRESS_IP=<ip> BASE_URL=http://4life.test ./scripts/smoke-test.sh        (Kubernetes/Ingress)
set -euo pipefail
BASE="${BASE_URL:-http://localhost:8080}"
EMAIL="smoke-$(date +%s)-$RANDOM@4life.local"
SENHA="senha-de-teste-123"
# Data sorteada: o ponto de coleta de Lavras atende 1 mobilização por dia (capacidade usada pela SAGA),
# então repetir sempre a mesma data faria a segunda execução cair na compensação.
DATA="$(date -d "+$((30 + RANDOM % 1500)) days" +%Y-%m-%d)T09:00:00-03:00"
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
falha(){ printf '  \033[31m✘ %s\033[0m\n' "$*"; exit 1; }
# No K8s: INGRESS_IP=<ip> BASE_URL=http://4life.test → o curl resolve o host para o IP do Ingress.
RESOLVE=()
if [[ -n ${INGRESS_IP:-} ]]; then
  HOST=${BASE#*://}; HOST=${HOST%%/*}
  RESOLVE=(--resolve "${HOST}:80:${INGRESS_IP}")
fi
req()  { curl -sS "${RESOLVE[@]}" -o /tmp/smoke.$$ -w '%{http_code}' "$@"; }
corpo(){ cat /tmp/smoke.$$; }
trap 'rm -f /tmp/smoke.$$' EXIT

echo "== 4Life smoke test em $BASE"

[[ $(req "$BASE/health") == 200 ]] && ok "gateway /health" || falha "gateway /health"

[[ $(req "$BASE/api/mobile/info/faq") == 200 ]] && ok "rota pública sem token: $(corpo | jq length) perguntas no FAQ" || falha "FAQ público"

[[ $(req "$BASE/api/web/painel") == 401 ]] && ok "rota protegida sem token → 401" || falha "esperava 401"

[[ $(req "$BASE/api/web/auth/verificar-credenciais" -X POST) == 404 ]] && ok "rota interna do BFF bloqueada no gateway → 404" || falha "rota interna exposta"

codigo=$(req "$BASE/api/web/cadastro" -H 'content-type: application/json' \
  -d "{\"nome\":\"Smoke Test\",\"email\":\"$EMAIL\",\"senha\":\"$SENHA\",\"cidade\":\"Lavras\",\"uf\":\"MG\",\"tipoSanguineo\":\"O+\"}")
[[ $codigo == 201 ]] && ok "cadastro de doador ($EMAIL)" || falha "cadastro: $codigo $(corpo)"

[[ $(req "$BASE/auth/login" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"senha\":\"errada-123\"}") == 401 ]] \
  && ok "login com senha errada → 401" || falha "login inválido aceito"

[[ $(req "$BASE/auth/login" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"senha\":\"$SENHA\"}") == 200 ]] || falha "login: $(corpo)"
TOKEN=$(corpo | jq -r .token); AUTH=(-H "authorization: Bearer $TOKEN")
ok "login → JWT emitido"

codigo=$(req "$BASE/api/web/comunidades" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"nome":"Comunidade do Smoke Test","descricao":"criada pelo teste","cidade":"Lavras","uf":"MG"}')
[[ $codigo == 201 ]] || falha "criar comunidade: $codigo $(corpo)"
COM=$(corpo | jq -r .id)
ok "comunidade criada ($COM), totalMobilizacoes=$(corpo | jq .totalMobilizacoes)"

codigo=$(req "$BASE/api/web/comunidades/$COM/mobilizacoes" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"titulo\":\"Mobilização do smoke test\",\"dataHora\":\"$DATA\",\"hemocentroId\":\"33333333-3333-4333-8333-333333333331\",\"vagas\":10}")
[[ $codigo == 202 ]] || falha "criar mobilização: $codigo $(corpo)"
MOB=$(corpo | jq -r .id)
ok "mobilização aceita ($MOB) → 202, estado $(corpo | jq -r .estado); SAGA iniciada"

# A SAGA roda de forma ASSÍNCRONA: T2 (comunidades) → T3 (informacoes) → T4 (confirma).
for i in $(seq 1 30); do
  req "$BASE/api/web/mobilizacoes/$MOB/saga" "${AUTH[@]}" > /dev/null
  estado=$(corpo | jq -r .estado)
  [[ $estado == CONCLUIDA || $estado == COMPENSADA || $estado == FALHOU ]] && break
  sleep 0.5
done
[[ $estado == CONCLUIDA ]] && ok "SAGA CONCLUIDA: $(corpo | jq -r '[.historico[].etapa] | join(" → ")')" || falha "saga terminou em $estado: $(corpo | jq -c .historico)"

# O contador e o painel (CQRS) são atualizados de forma ASSÍNCRONA pelos consumidores do comunidades-service.
for i in $(seq 1 20); do
  req "$BASE/api/web/comunidades/$COM" "${AUTH[@]}" > /dev/null
  total=$(corpo | jq .totalMobilizacoes)
  [[ $total == 1 ]] && break
  sleep 0.5
done
[[ $total == 1 ]] && ok "evento consumido: painel (modelo de leitura, fonte=$(corpo | jq -r .fonte)) com totalMobilizacoes = $total" || falha "evento não consumido (total=$total)"

[[ $(req "$BASE/api/mobile/mobilizacoes/$MOB/interesse" -X POST "${AUTH[@]}") == 201 ]] && ok "interesse registrado (mobile)" || falha "interesse: $(corpo)"
[[ $(req "$BASE/api/mobile/mobilizacoes/$MOB/interesse" -X POST "${AUTH[@]}") == 409 ]] && ok "interesse duplicado → 409" || falha "duplicado aceito"

[[ $(req "$BASE/api/mobile/inicio" "${AUTH[@]}") == 200 ]] || falha "inicio: $(corpo)"
ok "tela inicial agregada (bff-mobile): $(corpo | jq -c '{usuario: .usuario.nome, proximas: (.proximasMobilizacoes|length), comunidades: (.minhasComunidades|length), dica: .dica.titulo}')"

[[ $(req "$BASE/api/web/mobilizacoes/$MOB" "${AUTH[@]}") == 200 ]] || falha "detalhe web"
ok "detalhe agregado (bff-web): hemocentro='$(corpo | jq -r .hemocentro.nome)', comunidade='$(corpo | jq -r .comunidade.nome)'"

# Um usuário comum não pode criar mobilização numa comunidade em que não é admin.
[[ $(req "$BASE/api/web/comunidades/22222222-2222-4222-8222-222222222221/mobilizacoes" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"titulo":"Não deveria","dataHora":"2027-01-15T09:00:00-03:00"}') == 403 ]] && ok "não-admin criando mobilização → 403" || falha "esperava 403"

[[ $(req "$BASE/api/mobile/diagnostico/whoami") == 200 ]] && ok "whoami: $(corpo | jq -c .)" || falha "whoami"

[[ $(req "$BASE/api/mobile/info/assistente/status") == 200 ]] || falha "status do assistente"
ok "assistente: base $(corpo | jq -r .ingestao.status) ($(corpo | jq -r .ingestao.trechos) trechos), circuito do LLM $(corpo | jq -r .circuitos.llm.estado)"
[[ $(req "$BASE/api/mobile/assistente/perguntar" "${AUTH[@]}" -H 'content-type: application/json' -d '{"pergunta":"Preciso estar em jejum para doar sangue?"}') == 200 ]] \
  && ok "assistente respondeu (origem=$(corpo | jq -r .origem)): $(corpo | jq -r .resposta | head -c 120)" || falha "assistente: $(corpo)"

echo "== tudo certo"

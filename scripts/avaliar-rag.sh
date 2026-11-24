#!/usr/bin/env bash
# Avaliação do RAG: cada pergunta de docs/llm/perguntas-avaliacao.json é feita COM e SEM recuperação
# (mesmo modelo, sem cache) pelo gateway. A resposta é considerada correta quando contém todos os
# fatos-chave esperados e nenhum padrão proibido (que contradiz o esperado).
# Grava tudo em docs/llm/avaliacao-rag-resultados.json.
# Uso: ./scripts/avaliar-rag.sh                    (compose)
#      INGRESS_IP=<ip> BASE_URL=http://4life.test SAIDA=docs/llm/avaliacao-rag-resultados-k8s.json ./scripts/avaliar-rag.sh   (Kubernetes)
set -euo pipefail
cd "$(dirname "$0")/.."
BASE="${BASE_URL:-http://localhost:8080}"
PERGUNTAS=docs/llm/perguntas-avaliacao.json
SAIDA="${SAIDA:-docs/llm/avaliacao-rag-resultados.json}"
RESOLVE=()
if [[ -n ${INGRESS_IP:-} ]]; then HOST=${BASE#*://}; HOST=${HOST%%/*}; RESOLVE=(--resolve "${HOST}:80:${INGRESS_IP}"); fi
c() { curl -sS "${RESOLVE[@]}" "$@"; }

EMAIL="avaliacao-$(date +%s)-$RANDOM@4life.local"
c "$BASE/api/web/cadastro" -H 'content-type: application/json' \
  -d "{\"nome\":\"Avaliação RAG\",\"email\":\"$EMAIL\",\"senha\":\"senha-avaliacao\",\"cidade\":\"Lavras\",\"uf\":\"MG\"}" > /dev/null
TOKEN=$(c "$BASE/auth/login" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"senha\":\"senha-avaliacao\"}" | jq -r .token)

STATUS=$(c "$BASE/api/web/info/assistente/status")
echo "modelo: $(jq -r .modelo <<< "$STATUS") | embeddings: $(jq -r .modeloEmbeddings <<< "$STATUS") | trechos na base: $(jq -r .ingestao.trechos <<< "$STATUS")"

resultados='[]'
total=$(jq length "$PERGUNTAS")
for i in $(seq 0 $((total - 1))); do
  item=$(jq ".[$i]" "$PERGUNTAS")
  pergunta=$(jq -r .pergunta <<< "$item")
  printf '\n[%s] %s\n' "$(jq -r .id <<< "$item")" "$pergunta"
  for rag in true false; do
    corpo=$(jq -n --arg p "$pergunta" --argjson r "$rag" '{pergunta: $p, usarRag: $r, usarCache: false}')
    r=$(c "$BASE/api/web/assistente/perguntar" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$corpo")
    resposta=$(jq -r .resposta <<< "$r")
    # fato-chave presente? (cada fato é uma regex com alternativas; todos precisam aparecer)
    acertos=0; nfatos=$(jq '.fatos | length' <<< "$item")
    for f in $(seq 0 $((nfatos - 1))); do
      padrao=$(jq -r ".fatos[$f]" <<< "$item")
      grep -qiE -- "$padrao" <<< "$resposta" && acertos=$((acertos + 1)) || true
    done
    # padrões proibidos: a resposta contradiz o esperado (ex.: "Sim" quando o certo é "não")
    contradiz=false
    for f in $(seq 0 $(($(jq '.proibidos // [] | length' <<< "$item") - 1))); do
      grep -qiE -- "$(jq -r ".proibidos[$f]" <<< "$item")" <<< "$resposta" && contradiz=true || true
    done
    ok=$([[ $acertos == "$nfatos" && $contradiz == false ]] && echo true || echo false)
    printf '  %-8s %s (%s/%s fatos, %sms, %s)\n' "$([[ $rag == true ]] && echo 'COM RAG' || echo 'SEM RAG')" \
      "$([[ $ok == true ]] && echo '✔' || echo '✘')" "$acertos" "$nfatos" "$(jq -r .duracaoMs <<< "$r")" "$(jq -r .origem <<< "$r")"
    resultados=$(jq --argjson item "$item" --argjson r "$r" --argjson rag "$rag" --argjson ok "$ok" --argjson a "$acertos" --argjson c "$contradiz" \
      '. + [{id: $item.id, pergunta: $item.pergunta, esperado: $item.esperado, usarRag: $rag, resposta: $r.resposta,
             fatosEncontrados: $a, fatosEsperados: ($item.fatos | length), contradiz: $c, correta: $ok, origem: $r.origem,
             duracaoMs: $r.duracaoMs, fontes: $r.fontes}]' <<< "$resultados")
  done
done

jq '{geradoEm: (now | todate), resultados: .}' <<< "$resultados" > "$SAIDA"
com=$(jq '[.resultados[] | select(.usarRag and .correta)] | length' "$SAIDA")
sem=$(jq '[.resultados[] | select((.usarRag | not) and .correta)] | length' "$SAIDA")
printf '\nResumo: COM RAG %s/%s corretas | SEM RAG %s/%s corretas\nDetalhes: %s\n' "$com" "$total" "$sem" "$total" "$SAIDA"

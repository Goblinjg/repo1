# Parte 4: sistema em funcionamento

Guia da apresentação ao vivo: cada requisito do enunciado, onde está no código e **o comando que o
demonstra**. O roteiro completo roda com um comando:

```bash
./scripts/demo-parte4.sh                               # docker compose (localhost:8080)
MODO=k8s INGRESS_IP=<ip> ./scripts/demo-parte4.sh      # Kubernetes (kind + Ingress)
```

O script pausa entre as etapas (Enter) e **pergunta antes** de provocar falhas: derrubar o
informacoes-service (timeout da SAGA) e derrubar o Ollama (fallback do LLM).

## Subir o ambiente

| Ambiente | Comandos | Observação |
|---|---|---|
| Docker Compose | `./scripts/gerar-env.sh` (1ª vez) → `docker compose up -d --build` | Na 1ª vez, o serviço `ollama-modelos` baixa ~1,6 GB de modelos para o volume `ollama-data`. |
| Kubernetes (kind) | `./scripts/k8s-up.sh` | Espera o Job `ollama-modelos` terminar o download para o PVC do Ollama. |
| Verificação rápida | `./scripts/smoke-test.sh` | Ponta a ponta: SAGA, painel CQRS e assistente. |

Recursos: o Ollama usa ~1–2 GB de RAM (`qwen2.5:0.5b` + `bge-m3`, em CPU).

> **Kubernetes:** o Envoy do Ingress (cloud-provider-kind) corta requisições em **15 s** (padrão,
> sem timeout configurado na rota). Por isso o assistente no cluster tem um orçamento de **12 s**
> por pergunta (`ASSISTENTE_ORCAMENTO_MS`): se estourar, a resposta vem em fallback em vez de virar um
> 504 na borda. O pod do Ollama tem limite de 8 CPUs; com 4, as respostas com tool passavam de 12 s.

## 6.1 Sistema distribuído funcional

| Requisito | Como é demonstrado | Código |
|---|---|---|
| **Fluxo completo ponta a ponta** (gateway → BFF → serviços) | Etapa 1 do roteiro: cadastro, login (o gateway assina o JWT), comunidade e mobilização, tudo por `/api/web/**` e `/api/mobile/**`. `./scripts/smoke-test.sh` cobre o fluxo inteiro. | `gateway/`, `bff/`, `services/` |
| **SAGA: caminho feliz** | Etapa 2: `POST /api/web/comunidades/{id}/mobilizacoes` → **202** + `_links.saga`; a linha do tempo mostra T1 → T2 → T3 → T4 e a mobilização fica `CONFIRMADA`. | `services/mobilizacoes-service/src/saga/` |
| **SAGA: falha com compensação provocada** | Etapa 3: outra comunidade pede o **mesmo hemocentro no mesmo dia** (o ponto de Lavras atende 1 por dia): T2 reserva a data, **T3 é recusado**, **C2 libera a data** e **C1 cancela** com o motivo. A prova vem dos dois bancos (`reservas_calendario` e `reservas_hemocentro`): só sobra a reserva da mobilização feliz. | `comunidades-service/src/saga.ts`, `informacoes-service/src/saga.ts` |
| SAGA: timeout (extra) | Etapa 4 (opcional): o script **derruba o informacoes-service**, cria a mobilização e, depois de 30 s, a saga entra em `COMPENSANDO` (C3 → C2 → C1). Ao religar o serviço, a resposta atrasada é **ignorada**, C3 desfaz a reserva tardia e a saga termina `COMPENSADA`, sem deixar reserva órfã. | `orquestrador.ts` (`verificarPrazos`) |
| **Consulta ao modelo de leitura do CQRS refletindo uma escrita** | Etapa 5: `GET /api/web/comunidades/{id}` (lido do documento `painel_comunidade`, `fonte: "modelo-de-leitura"`) → um doador **entra na comunidade** (escrita no modelo normalizado + evento na outbox) → a leitura imediata ainda pode mostrar a versão anterior → **1,5 s depois** aparecem o novo membro, uma `versao` maior e um `atualizadoEm` novo. | `comunidades-service/src/cqrs/modelo-leitura.ts` |
| **Bancos separados por serviço, evidenciados** | Etapa 6: lista as tabelas de cada um dos 4 bancos (instâncias PostgreSQL separadas). `./scripts/teste-isolamento.sh` / `k8s-teste-isolamento.sh` provam que um serviço **não alcança** o banco de outro, nem pelo IP. | `docker-compose.yml` (redes `data-*`), `k8s/*/networkpolicy.yaml` |

Padrões de suporte implementados nesta parte: **Transactional Outbox + relay** (em todo serviço que
publica), **consumo idempotente** (`eventos_processados`), **publisher confirms** e topologia do
RabbitMQ declarada por todos os serviços. Detalhes em [`arquitetura.md`](arquitetura.md) §5–8.

## 6.2 Integração de LLM

| Requisito | Como é atendido | Onde |
|---|---|---|
| Propósito real no domínio | Assistente de dúvidas do doador (critérios, impedimentos, regras do 4Life) com fontes e dados reais. Ataca a barreira "falta de informação e mitos" do problema. | [`llm/README.md`](llm/README.md) |
| **RAG: base própria** | 10 documentos escritos para o 4Life + conteúdos e FAQ do banco (41 trechos). | `services/informacoes-service/conhecimento/` |
| **RAG: pipeline completo** | ingestão → divisão em trechos → embeddings (`bge-m3`) → **pgvector** (HNSW) → recuperação (k = 3) → geração (`qwen2.5:0.5b`) | `src/assistente/ingestao.ts`, `vetores.ts`, `cadeia.ts` |
| **RAG: avaliação com e sem recuperação (≥ 5 perguntas)** | 8 perguntas: **COM RAG 8/8 no Compose e 7/8 no Kubernetes; SEM RAG 0/8 nos dois**, com análise, variação entre ambientes, limitações e histórico de iterações. Reproduzível com `./scripts/avaliar-rag.sh`. | [`llm/avaliacao-rag.md`](llm/avaliacao-rag.md) |
| **LangChain: chains** | Composição LCEL: `RunnableSequence` + `RunnablePassthrough.assign` (tools e recuperação em paralelo) + `ChatPromptTemplate` + `ChatOllama` + `StringOutputParser`. | `src/assistente/cadeia.ts` |
| **LangChain: tool com dados reais** | `buscar_hemocentros` e `verificar_disponibilidade` (lê as **reservas feitas pela SAGA**), via `bindTools`: o modelo decide quando chamar. | `src/assistente/ferramentas.ts` |
| Agente (opcional) | **Não usado**, com justificativa: o fluxo é fixo (uma rodada de tools); um agente custaria mais chamadas e seria instável com 0,5 B. | [`llm/README.md`](llm/README.md#langchain-chains-e-tools) |
| **LLM como serviço distribuído (≥ 2 mecanismos)** | **Os 4:** circuit breaker, timeout + retry com backoff, cache por chave **e** semântico, fallback sem LLM. | `src/assistente/resiliencia.ts`, `servico.ts` |

Demonstração ao vivo (etapa 7 do roteiro):

1. pergunta com RAG (mostra fontes e similaridade);
2. a mesma pergunta **sem** recuperação, com a resposta errada (linha de base);
3. pergunta que faz o modelo **chamar a tool**, com a disponibilidade real do hemocentro na data
   reservada pela SAGA da etapa 2;
4. repetir a pergunta 1, que vem do cache (~2 ms);
5. (opcional) **derrubar o Ollama**: as respostas vêm em fallback; na 3ª falha o circuito abre e o
   fallback passa a ser imediato. Depois de religar, o circuito fecha sozinho (MEIO_ABERTO → FECHADO).

## Correções feitas no caminho

- `bff/bff-mobile/src/app.ts`: removido um `// @ts-expect-error` sem uso (commit `45849a5`) que
  fazia o `tsc` falhar, o que quebrava o build da imagem do bff-mobile.
- `docs/api/bff-web.yaml` e `bff-mobile.yaml`: faltavam chaves de fechamento nas linhas `/info/*`;
  os arquivos não eram YAML válido.

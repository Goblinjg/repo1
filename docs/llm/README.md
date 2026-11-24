# Assistente de dúvidas do 4Life: RAG + LangChain + LLM como serviço distribuído

> Requisito 6.2 da Parte 4. Código em
> [`services/informacoes-service/src/assistente/`](../../services/informacoes-service/src/assistente/).
> Avaliação com e sem recuperação em [`avaliacao-rag.md`](avaliacao-rag.md). Decisão em
> [ADR-0005](../adr/0005-llm-local-rag.md).

## Propósito no domínio

As barreiras para doar sangue incluem **falta de informação, mitos e dúvidas sobre critérios**
(ver README). O assistente responde dúvidas do doador, como "posso doar depois de uma tatuagem?",
"preciso estar em jejum?" ou "quem pode criar uma mobilização?", **com base na base de conhecimento
do 4Life**. Ele também consulta **dados reais do sistema**: hemocentros de uma cidade e janelas de
coleta livres numa data, que são as mesmas reservas usadas pela SAGA.

Não é um chatbot decorativo: a resposta mostra as **fontes**, informa a **origem** (LLM, cache ou
fallback) e continua útil mesmo com o LLM fora do ar.

## Onde roda

```text
 app / web ──▶ gateway ──▶ bff-mobile / bff-web ──▶ informacoes-service ──┬──▶ Ollama (LLM + embeddings)   rede llm
   POST /api/{mobile,web}/assistente/perguntar    POST /assistente/perguntar ├──▶ informacoes-db (pgvector)  rede data-informacoes
   (JWT obrigatório; timeout de 55 s no gateway                              └──  tools: hemocentros e reservas_hemocentro
    e de 50 s no BFF, só nesta rota)                                              (mesmo banco)
```

- **Ollama** (`ollama/ollama:0.40.18`) roda como componente próprio: serviço no compose, Deployment +
  PVC + Job de download dos modelos no Kubernetes. Só o `informacoes-service` alcança o Ollama (rede
  `llm` / NetworkPolicy `ollama-permite-informacoes`).
- **Modelos:** `qwen2.5:0.5b` para geração e uso de ferramentas, e `bge-m3` para embeddings
  (multilíngue; a comparação com outros modelos está em [`avaliacao-rag.md`](avaliacao-rag.md#escolha-do-modelo-de-embeddings)).
  Os dois são configuráveis por `LLM_MODELO` e `EMBEDDINGS_MODELO`.
- **Base vetorial:** PostgreSQL 16 + **pgvector** no banco do próprio informacoes-service (imagem
  `pgvector/pgvector:pg16`), mantendo o *database per service*.

## Pipeline RAG completo

| Etapa | Implementação | Arquivo |
|---|---|---|
| **Base de conhecimento própria** | 10 documentos Markdown escritos para o 4Life: critérios, impedimentos, intervalos, processo, cuidados, tipos sanguíneos, mitos e **regras da plataforma** (mobilizações, comunidades). Também entram os conteúdos e o FAQ do banco do serviço. | `conhecimento/*.md` |
| **Ingestão** | Carrega arquivos e tabelas; `RecursiveCharacterTextSplitter` (markdown, 450 caracteres, sobreposição de 40) com o título do documento em cada trecho → **41 trechos** | `ingestao.ts` |
| **Embeddings** | `OllamaEmbeddings` (bge-m3, 1024 dimensões), em lotes de 8, protegidos por timeout + retry + circuit breaker | `vetores.ts` |
| **Armazenamento vetorial** | Tabela `rag_trechos (conteudo, metadados, embedding vector(1024), busca tsvector)` com índice **HNSW** (cosseno) e índice GIN para a busca textual do fallback | `migrations/004_rag.sql` |
| **Recuperação** | `PgVectorStore` (subclasse de `VectorStore` do LangChain) → `similaritySearchWithScore`, k = 3 | `vetores.ts`, `cadeia.ts` |
| **Geração** | `ChatPromptTemplate` + `ChatOllama` + `StringOutputParser`, com o contexto e os dados das tools no prompt; temperatura 0 | `cadeia.ts` |

A ingestão é **idempotente**: um hash do conteúdo + modelo de embeddings fica em `rag_ingestao`, e a
base só é reprocessada se mudar. Um *advisory lock* garante que só uma réplica ingere por vez. No boot,
se o Ollama ainda estiver baixando os modelos, a ingestão tenta de novo com backoff, sem derrubar o
serviço. A ingestão usa prazo próprio (`RAG_INGESTAO_TIMEOUT_MS`, 120 s) e **não** passa pelo circuit
breaker. A primeira chamada carrega o modelo de embeddings na memória (num cluster frio isso passou de
20 s), e esse aquecimento não deve abrir o circuito das perguntas dos usuários. Para reprocessar à mão:
`POST /assistente/ingestao`.

> **Por que um `VectorStore` próprio em vez do `PGVectorStore` do `@langchain/community`?**
> O pacote `community` tem dependências opcionais incompatíveis com a versão atual do
> `@langchain/core` (conflito de peer dependencies que só se resolve com `--legacy-peer-deps`). A
> subclasse de `VectorStore` tem ~40 linhas, implementa o mesmo contrato (`addDocuments`,
> `similaritySearchVectorWithScore`, `asRetriever`) e controla o esquema da tabela, inclusive a
> coluna de busca textual usada pelo fallback.

## LangChain: chains e tools

O fluxo é uma composição **LCEL** (`RunnableSequence` + `RunnablePassthrough.assign` + `RunnableLambda`):

```text
{pergunta, usarRag}
  ├─ ferramentas: PROMPT_DECISAO → ChatOllama.bindTools([buscar_hemocentros, verificar_disponibilidade])
  │               → executa as tool_calls escolhidas pelo modelo
  └─ fontes:      PgVectorStore.similaritySearchWithScore(pergunta, 3)          (as duas em paralelo)
→ contexto = trechos formatados · dados = resultado das tools
→ PROMPT_RAG (ou PROMPT_SEM_RAG na linha de base) → ChatOllama → StringOutputParser → resposta
```

**Tools** (`ferramentas.ts`, criadas com `tool()` + esquema `zod`). Consultam o banco **real** do serviço:

| Tool | O que consulta | Exemplo de pergunta |
|---|---|---|
| `buscar_hemocentros(cidade)` | tabela `hemocentros`: nome, endereço, horário, capacidade diária | "Qual o endereço e horário do hemocentro de Varginha?" |
| `verificar_disponibilidade(cidade, data)` | `hemocentros` + `reservas_hemocentro` (as janelas reservadas pelo passo T3 da SAGA) | "O hemocentro de Lavras tem vaga para mobilização no dia 2027-02-05?" |

Quem decide **se** e **qual** tool chamar é o próprio modelo, via *tool calling* do Ollama. O
`qwen2.5:0.5b` escolheu corretamente nos testes: chama a tool nas perguntas sobre hemocentros e não
chama nas perguntas gerais. O resultado da tool vem em texto explícito ("HÁ VAGA" / "SEM VAGA") porque o
modelo pequeno interpretava mal um "0 de 1".

**Por que não um agente?** O fluxo não exige decisão dinâmica em várias etapas. As tools são
independentes (nenhuma precisa do resultado de outra) e uma rodada de decisão basta. Um agente com
laço de raciocínio/ação faria mais chamadas ao LLM (latência e pontos de falha) e, com um modelo de
0,5 B, tenderia a se perder no laço. Uma *chain* fixa é mais previsível, mais rápida e mais fácil de
proteger com timeout e circuit breaker.

## O LLM como dependência remota falível

Os **quatro** mecanismos pedidos estão implementados (o mínimo era dois):

| Mecanismo | Como funciona | Configuração (env) | Arquivo |
|---|---|---|---|
| **Timeout + retry com backoff** | Cada tentativa tem prazo próprio (`AbortSignal`, com `Promise.race` para garantir o prazo mesmo se a biblioteca ignorar o sinal). Entre tentativas: backoff exponencial com jitter de ±25 %. | `LLM_TIMEOUT_MS=20000`, `LLM_TENTATIVAS=2`, `LLM_BACKOFF_MS=1000` | `resiliencia.ts` |
| **Circuit breaker** | Dois circuitos, `llm` (chat) e `embeddings`. **FECHADO** → depois de N falhas seguidas, **ABERTO** (rejeita na hora, sem esperar timeout) → depois de X ms, **MEIO_ABERTO** (deixa uma chamada de teste passar; sucesso fecha, falha reabre). | `LLM_CIRCUITO_FALHAS=3`, `LLM_CIRCUITO_ABERTO_MS=30000` | `resiliencia.ts` |
| **Cache por chave e semântico** | (1) **chave** = modo + modelo + pergunta normalizada (sem acento, caixa e pontuação); (2) **semântico** = vizinho mais próximo do embedding da pergunta em `assistente_cache` (pgvector), aceito se a similaridade for ≥ 0,95. Fica no banco, então é **compartilhado entre réplicas**. Respostas que usaram tools (dados que mudam) não são guardadas. A ingestão de uma base nova limpa o cache. | `LLM_CACHE_TTL_S=86400`, `LLM_CACHE_SIMILARIDADE=0.95` | `servico.ts` |
| **Orçamento de tempo por pergunta** | Prazo total (embedding + tools + geração, com retries). Se estourar, vira fallback. Precisa ser **menor que o timeout de quem chama**: BFF 50 s, gateway 55 s e, no Kubernetes, o Envoy do Ingress, que corta em 15 s. Por isso o cluster usa 12 s. | `ASSISTENTE_ORCAMENTO_MS=45000` (compose) / `12000` (k8s) | `servico.ts` |
| **Fallback** | Se o LLM falhar (timeout, erro ou circuito aberto), a resposta é montada **sem LLM**: busca textual em português (`tsvector`) nos mesmos trechos + `buscar_hemocentros` direto no banco quando a pergunta cita uma cidade. A resposta vem com `origem: "fallback"` e o motivo em `aviso`. | — | `servico.ts` |

O `/ready` do informacoes-service **não** depende do Ollama: sem LLM, o serviço continua no ar e o
assistente responde em fallback.

### Evidência (testes executados no compose)

| Cenário | Resultado observado |
|---|---|
| Pergunta nova | `origem: llm`, ~5–7 s (a primeira carrega o modelo na memória) |
| Mesma pergunta | `origem: cache`, **8 ms** |
| Mesma pergunta sem acento/pontuação | `origem: cache`, 9 ms (chave normalizada) |
| "Quanto tempo demora para doar sangue?" depois de "Quanto tempo leva a doação de sangue?" | `origem: cache-semantico`, **64 ms** |
| Ollama parado, 1ª a 3ª pergunta | `origem: fallback`, aviso "o modelo não respondeu dentro do prazo", ~41 s (2 × 20 s + backoff) |
| Ollama parado, 4ª pergunta | circuito `embeddings` **ABERTO** → `origem: fallback`, aviso "circuit breaker aberto…", **2 ms** |
| Fallback com cidade na pergunta | trechos da busca textual + `buscar_hemocentros` executada direto no banco |
| Ollama religado, depois de 30 s | log `MEIO_ABERTO: testando o provedor` → `FECHADO: provedor respondeu`; `origem: llm` de novo |

## API

`POST /api/{mobile,web}/assistente/perguntar` (JWT) com o corpo
`{ "pergunta": "...", "usarRag": true, "usarCache": true }`.

Resposta do **bff-web** (completa):

```json
{
  "pergunta": "Fiz uma tatuagem, quanto tempo preciso esperar para doar sangue?",
  "resposta": "12 meses.",
  "origem": "llm",
  "usouRag": true,
  "fontes": [{ "titulo": "Quem tem tatuagem pode doar?", "fonte": "faq", "similaridade": 0.699 }, "…"],
  "ferramentas": [],
  "modelo": "qwen2.5:0.5b",
  "duracaoMs": 4505
}
```

O **bff-mobile** devolve só `resposta`, `origem`, os títulos das `fontes` e o `aviso`. O estado do
assistente (ingestão, circuitos, cache e política de retry) é público em
`GET /api/{mobile,web}/info/assistente/status`.

## Limitações conhecidas

- O `qwen2.5:0.5b` roda bem em CPU, mas às vezes escreve mal ou responde perguntas fora da base sem
  admitir que não sabe (detalhes em [`avaliacao-rag.md`](avaliacao-rag.md#análise)). Trocar para um
  modelo maior é só mudar `LLM_MODELO`.
- Com o Ollama **parado** na rede `internal` do compose, o DNS não responde "não existe" na hora: a
  chamada espera o timeout. Por isso as primeiras falhas levam ~41 s, até o circuito abrir.
- O conteúdo da base é **orientativo**; os textos sempre mandam confirmar os critérios com o hemocentro.

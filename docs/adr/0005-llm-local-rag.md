# ADR-0005 — Assistente com RAG usando LLM local (Ollama) e pgvector no informacoes-service

**Status:** aceito (Parte 4)

## Contexto

A Parte 4 exige um LLM com propósito real no domínio, RAG completo (ingestão → embeddings → base
vetorial → recuperação → geração), LangChain com chains e ao menos uma tool sobre dados reais, e o
LLM tratado como dependência remota falível (≥ 2 mecanismos entre circuit breaker, timeout/retry,
cache e fallback). A demonstração precisa rodar ao vivo, em ambiente local, sem depender de chave paga.

## Decisão

1. **Onde:** o assistente fica no `informacoes-service`, que já é dono dos conteúdos, do FAQ e dos
   hemocentros (as fontes do RAG e das tools). Não foi criado um serviço novo: o domínio é o mesmo
   e não há equipe ou ciclo de deploy separado que justifique outro serviço.
2. **LLM:** **Ollama local** com `qwen2.5:0.5b` (escolha da equipe): gratuito, roda em CPU, funciona
   offline na apresentação e suporta *tool calling*. Fica num componente próprio (container/Deployment
   + volume de modelos), acessível **só** pelo informacoes-service.
3. **Embeddings:** `bge-m3` no mesmo Ollama. Ele recuperou o trecho certo em 8/8 perguntas contra 6/8
   do `nomic-embed-text` (medição em `docs/llm/avaliacao-rag.md`).
4. **Base vetorial:** **pgvector** no `informacoes-db` (imagem `pgvector/pgvector:pg16`). Mantém o
   *database per service* e reaproveita backup, StatefulSet e PVC já existentes; um banco vetorial
   separado (Qdrant, Chroma) seria mais um componente para operar sem ganho neste volume (dezenas de
   trechos).
5. **LangChain.js** (`@langchain/core`, `@langchain/ollama`, `@langchain/textsplitters`) com LCEL. O
   `VectorStore` sobre pgvector foi implementado no projeto (subclasse do contrato do LangChain)
   porque o `@langchain/community` tem conflito de *peer dependencies* com o core atual.
6. **Chain, não agente:** uma rodada de decisão de tools + recuperação em paralelo + geração. O fluxo
   não precisa de laço dinâmico; um agente custaria mais chamadas e seria instável com um modelo de 0,5 B.
7. **Resiliência:** os quatro mecanismos (timeout + retry com backoff, circuit breaker, cache por
   chave e semântico, fallback sem LLM). O `/ready` do serviço não depende do LLM.

## Consequências

- (+) Roda inteiro na máquina de quem apresenta, sem custo nem internet (depois do primeiro download
  de ~1,6 GB de modelos).
- (+) O fallback e o circuit breaker podem ser demonstrados ao vivo, parando o Ollama.
- (−) Um modelo de 0,5 B escreve mal às vezes e nem sempre admite quando não sabe; a troca por um
  modelo maior é só configuração (`LLM_MODELO`).
- (−) O Ollama precisa de ~1–2 GB de RAM. No Kubernetes ele tem *requests* de 1 Gi e limite de 4 Gi.

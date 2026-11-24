# Assistente de dúvidas (RAG + LangChain + LLM local)

| Arquivo | Papel |
|---|---|
| `ingestao.ts` | carrega `conhecimento/*.md` + conteúdos/FAQ do banco, divide em trechos, gera embeddings e grava no pgvector |
| `vetores.ts` | `PgVectorStore` (contrato `VectorStore` do LangChain sobre pgvector) e embeddings com cache/proteção |
| `ferramentas.ts` | tools `buscar_hemocentros` e `verificar_disponibilidade` (dados reais do banco) |
| `cadeia.ts` | chain LCEL: decisão de tools + recuperação → prompt → ChatOllama → texto |
| `resiliencia.ts` | circuit breaker e timeout + retry com backoff |
| `servico.ts` | cache por chave e semântico, chamada protegida e fallback sem LLM |
| `rotas.ts` | `POST /assistente/perguntar`, `GET /assistente/status`, `POST /assistente/ingestao`, `DELETE /assistente/cache` |

Documentação completa: [`docs/llm/README.md`](../../../../docs/llm/README.md).

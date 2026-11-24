-- Parte 4: assistente com RAG. Base vetorial no próprio banco do serviço (pgvector).
-- A extensão vem da imagem pgvector/pgvector:pg16.
CREATE EXTENSION IF NOT EXISTS vector;

-- Trechos (chunks) da base de conhecimento com o embedding de cada um.
-- 1024 = dimensão do modelo bge-m3 (embeddings multilíngues; ver docs/llm/README.md).
CREATE TABLE rag_trechos (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conteudo  text NOT NULL,
  metadados jsonb NOT NULL DEFAULT '{}',
  embedding vector(1024) NOT NULL,
  -- busca textual para o fallback quando o modelo de embeddings está fora do ar
  busca     tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', conteudo)) STORED
);
CREATE INDEX rag_trechos_embedding_idx ON rag_trechos USING hnsw (embedding vector_cosine_ops);
CREATE INDEX rag_trechos_busca_idx ON rag_trechos USING gin (busca);

-- Controle da ingestão: só reprocessa se a base de conhecimento mudar (hash do conteúdo).
CREATE TABLE rag_ingestao (
  hash         text PRIMARY KEY,
  documentos   integer NOT NULL,
  trechos      integer NOT NULL,
  ingerido_em  timestamptz NOT NULL DEFAULT now()
);

-- Cache das respostas do LLM: por chave (pergunta normalizada) e semântico (embedding da pergunta).
-- Fica no banco para ser compartilhado entre as réplicas do serviço.
CREATE TABLE assistente_cache (
  chave      text PRIMARY KEY,
  pergunta   text NOT NULL,
  embedding  vector(1024),
  resposta   jsonb NOT NULL,
  acertos    integer NOT NULL DEFAULT 0,
  criado_em  timestamptz NOT NULL DEFAULT now(),
  expira_em  timestamptz NOT NULL
);

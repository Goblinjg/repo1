CREATE TABLE comunidades (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome               text NOT NULL,
  descricao          text,
  cidade             text NOT NULL,
  uf                 char(2) NOT NULL,
  criador_id         uuid NOT NULL,          -- referência lógica a doadores-service (sem FK entre bancos)
  total_mobilizacoes integer NOT NULL DEFAULT 0,
  criado_em          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comunidades_cidade_idx ON comunidades (lower(cidade), uf);

CREATE TABLE membros (
  comunidade_id uuid NOT NULL REFERENCES comunidades(id) ON DELETE CASCADE,
  doador_id     uuid NOT NULL,
  papel         text NOT NULL CHECK (papel IN ('admin', 'membro')),
  entrou_em     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comunidade_id, doador_id)
);
CREATE INDEX membros_doador_idx ON membros (doador_id);

-- Inbox para consumo idempotente de eventos.
CREATE TABLE eventos_processados (
  evento_id      uuid PRIMARY KEY,
  tipo           text NOT NULL,
  processado_em  timestamptz NOT NULL DEFAULT now()
);

-- Transactional Outbox (Parte 4).
CREATE TABLE outbox (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agregado     text NOT NULL,
  agregado_id  uuid,
  tipo         text NOT NULL,
  payload      jsonb NOT NULL,
  criado_em    timestamptz NOT NULL DEFAULT now(),
  publicado_em timestamptz,
  tentativas   integer NOT NULL DEFAULT 0
);
CREATE INDEX outbox_pendentes_idx ON outbox (criado_em) WHERE publicado_em IS NULL;

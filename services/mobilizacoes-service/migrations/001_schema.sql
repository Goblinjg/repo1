CREATE TABLE mobilizacoes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comunidade_id uuid NOT NULL,            -- referência lógica a comunidades-service
  titulo        text NOT NULL,
  descricao     text,
  data_hora     timestamptz NOT NULL,
  cidade        text NOT NULL,
  uf            char(2) NOT NULL,
  hemocentro_id uuid,                     -- referência lógica a informacoes-service
  local         text,
  vagas         integer CHECK (vagas IS NULL OR vagas > 0),
  criador_id    uuid NOT NULL,            -- referência lógica a doadores-service
  criado_em     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mobilizacoes_data_idx ON mobilizacoes (data_hora);
CREATE INDEX mobilizacoes_comunidade_idx ON mobilizacoes (comunidade_id);

CREATE TABLE interesses (
  mobilizacao_id uuid NOT NULL REFERENCES mobilizacoes(id) ON DELETE CASCADE,
  doador_id      uuid NOT NULL,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mobilizacao_id, doador_id)
);
CREATE INDEX interesses_doador_idx ON interesses (doador_id);

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

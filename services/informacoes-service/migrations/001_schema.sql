CREATE TABLE conteudos (
  slug          text PRIMARY KEY,
  titulo        text NOT NULL,
  categoria     text NOT NULL CHECK (categoria IN ('requisitos','preparo','documentos','mitos','dica')),
  resumo        text NOT NULL,
  corpo         text NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE faq (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pergunta  text NOT NULL,
  resposta  text NOT NULL,
  categoria text NOT NULL,
  ordem     integer NOT NULL DEFAULT 0
);

CREATE TABLE hemocentros (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome     text NOT NULL,
  cidade   text NOT NULL,
  uf       char(2) NOT NULL,
  endereco text NOT NULL,
  telefone text,
  horarios text
);
CREATE INDEX hemocentros_cidade_idx ON hemocentros (lower(cidade), uf);

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

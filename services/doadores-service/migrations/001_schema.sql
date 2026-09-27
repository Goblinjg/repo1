CREATE TABLE doadores (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome               text NOT NULL,
  email              text NOT NULL UNIQUE,
  senha_hash         text,
  tipo_sanguineo     text CHECK (tipo_sanguineo IN ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
  cidade             text NOT NULL,
  uf                 char(2) NOT NULL,
  data_ultima_doacao date,
  criado_em          timestamptz NOT NULL DEFAULT now(),
  atualizado_em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX doadores_cidade_idx ON doadores (lower(cidade), uf);

-- Transactional Outbox (Parte 4): eventos gravados na mesma transação do dado de negócio.
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

-- Parte 4: participante da SAGA (T2/C2), modelo de leitura CQRS e Transactional Outbox.

-- Inbox: o mesmo evento pode ser consumido por mais de um consumidor do serviço
-- (ex.: mobilizacao.criada alimenta o contador E a projeção do painel).
ALTER TABLE eventos_processados ADD COLUMN consumidor text NOT NULL DEFAULT 'contador';
ALTER TABLE eventos_processados ALTER COLUMN consumidor DROP DEFAULT;
ALTER TABLE eventos_processados DROP CONSTRAINT eventos_processados_pkey;
ALTER TABLE eventos_processados ADD PRIMARY KEY (evento_id, consumidor);

-- Relay da outbox: backoff entre tentativas de publicação.
ALTER TABLE outbox
  ADD COLUMN proxima_tentativa_em timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN ultimo_erro text;

-- ---------------------------------------------------------------- SAGA (T2 / C2)
-- Calendário da comunidade: no máximo uma mobilização por dia. saga_id torna T2 e C2 idempotentes.
CREATE TABLE reservas_calendario (
  id             bigserial PRIMARY KEY,
  comunidade_id  uuid NOT NULL REFERENCES comunidades(id) ON DELETE CASCADE,
  data           date NOT NULL,
  saga_id        uuid UNIQUE,                 -- NULL para mobilizações anteriores à SAGA
  mobilizacao_id uuid,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (comunidade_id, data)
);

-- A mobilização de demonstração (seed) já ocupa o dia 05/12/2026 em Lavras.
INSERT INTO reservas_calendario (comunidade_id, data, mobilizacao_id)
SELECT id, DATE '2026-12-05', '44444444-4444-4444-8444-444444444441'
  FROM comunidades WHERE id = '22222222-2222-4222-8222-222222222221'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- CQRS (modelo de leitura)
-- Réplica local dos nomes dos doadores, mantida pelos eventos doador.cadastrado/atualizado.
-- Evita a chamada ao doadores-service por membro (o N+1 do painel).
CREATE TABLE doadores_nomes (
  doador_id     uuid PRIMARY KEY,
  nome          text NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- Réplica local das mobilizações, mantida pelos eventos mobilizacao.*.
CREATE TABLE mobilizacoes_resumo (
  id            uuid PRIMARY KEY,
  comunidade_id uuid NOT NULL,
  titulo        text NOT NULL,
  data_hora     timestamptz NOT NULL,
  estado        text NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mobilizacoes_resumo_comunidade_idx ON mobilizacoes_resumo (comunidade_id, data_hora);

-- Projeção desnormalizada: um documento pronto por comunidade (o que a tela do painel precisa).
CREATE TABLE painel_comunidade (
  comunidade_id uuid PRIMARY KEY,
  documento     jsonb NOT NULL,
  versao        bigint NOT NULL DEFAULT 1,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

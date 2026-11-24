-- Parte 4: SAGA orquestrada, Transactional Outbox com relay e inbox idempotente.

-- Estado da mobilização: nasce PENDENTE (T1) e termina CONFIRMADA (T4) ou CANCELADA (C1).
-- As mobilizações já existentes foram criadas antes da SAGA e ficam CONFIRMADA.
ALTER TABLE mobilizacoes
  ADD COLUMN estado text NOT NULL DEFAULT 'CONFIRMADA' CHECK (estado IN ('PENDENTE', 'CONFIRMADA', 'CANCELADA')),
  ADD COLUMN motivo_cancelamento text;
ALTER TABLE mobilizacoes ALTER COLUMN estado SET DEFAULT 'PENDENTE';

-- Estado persistido do orquestrador: sobrevive a reinícios e permite várias réplicas.
CREATE TABLE sagas (
  id             uuid PRIMARY KEY,
  mobilizacao_id uuid NOT NULL REFERENCES mobilizacoes(id),
  estado         text NOT NULL CHECK (estado IN ('INICIADA', 'EM_ANDAMENTO', 'CONCLUIDA', 'COMPENSANDO', 'COMPENSADA', 'FALHOU')),
  passo          text NOT NULL,                    -- passo em andamento: data | janela | fim
  concluidos     text[] NOT NULL DEFAULT '{}',     -- passos remotos concluídos (o que precisaria ser compensado)
  compensar      text[] NOT NULL DEFAULT '{}',     -- fila de compensações pendentes, em ordem reversa
  motivo         text,
  dados          jsonb NOT NULL,
  prazo_em       timestamptz,                      -- timeout do passo atual
  tentativas     integer NOT NULL DEFAULT 0,       -- reenvios da compensação atual
  criado_em      timestamptz NOT NULL DEFAULT now(),
  atualizado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sagas_mobilizacao_idx ON sagas (mobilizacao_id);
CREATE INDEX sagas_prazo_idx ON sagas (prazo_em) WHERE estado IN ('EM_ANDAMENTO', 'COMPENSANDO');

-- Linha do tempo de cada saga (para acompanhar e demonstrar).
CREATE TABLE saga_historico (
  id          bigserial PRIMARY KEY,
  saga_id     uuid NOT NULL REFERENCES sagas(id),
  ocorrido_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  etapa       text NOT NULL,
  descricao   text NOT NULL
);
CREATE INDEX saga_historico_saga_idx ON saga_historico (saga_id, id);

-- Relay da outbox: backoff entre tentativas de publicação.
ALTER TABLE outbox
  ADD COLUMN proxima_tentativa_em timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN ultimo_erro text;
DROP INDEX IF EXISTS outbox_pendentes_idx;
CREATE INDEX outbox_pendentes_idx ON outbox (criado_em) WHERE publicado_em IS NULL;

-- Inbox: respostas da SAGA processadas uma única vez.
CREATE TABLE eventos_processados (
  evento_id     uuid NOT NULL,
  consumidor    text NOT NULL,
  tipo          text NOT NULL,
  processado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (evento_id, consumidor)
);

-- Sincroniza as mobilizações já existentes com o modelo de leitura do comunidades-service (CQRS).
-- Usa um tipo próprio para não incrementar de novo o contador de mobilizações da comunidade.
WITH m AS (SELECT gen_random_uuid() AS evento_id, * FROM mobilizacoes)
INSERT INTO outbox (id, agregado, agregado_id, tipo, payload)
SELECT m.evento_id, 'mobilizacao', m.id, 'mobilizacao.sincronizada',
       jsonb_build_object(
         'id', m.evento_id, 'tipo', 'mobilizacao.sincronizada', 'ocorridoEm', now(),
         'dados', jsonb_build_object('mobilizacaoId', m.id, 'comunidadeId', m.comunidade_id,
                                     'titulo', m.titulo, 'dataHora', m.data_hora, 'estado', m.estado))
  FROM m;

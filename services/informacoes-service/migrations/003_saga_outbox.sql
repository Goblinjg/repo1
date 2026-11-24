-- Parte 4: participante da SAGA (T3/C3) e Transactional Outbox.

-- Capacidade de mobilizações (coletas em grupo) que cada hemocentro atende por dia.
ALTER TABLE hemocentros ADD COLUMN capacidade_diaria integer NOT NULL DEFAULT 2 CHECK (capacidade_diaria >= 0);
-- O ponto de coleta de Lavras é pequeno: uma mobilização por dia (usado na demonstração da compensação).
UPDATE hemocentros SET capacidade_diaria = 1 WHERE id = '33333333-3333-4333-8333-333333333331';

-- Janelas de coleta reservadas. saga_id torna T3 e C3 idempotentes.
CREATE TABLE reservas_hemocentro (
  id             bigserial PRIMARY KEY,
  hemocentro_id  uuid NOT NULL REFERENCES hemocentros(id),
  data           date NOT NULL,
  saga_id        uuid UNIQUE,              -- NULL para mobilizações anteriores à SAGA
  mobilizacao_id uuid,
  criado_em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservas_hemocentro_dia_idx ON reservas_hemocentro (hemocentro_id, data);

-- A mobilização de demonstração (seed) já ocupa a janela de 05/12/2026 em Lavras.
INSERT INTO reservas_hemocentro (hemocentro_id, data, mobilizacao_id)
VALUES ('33333333-3333-4333-8333-333333333331', DATE '2026-12-05', '44444444-4444-4444-8444-444444444441');

-- Relay da outbox: backoff entre tentativas de publicação.
ALTER TABLE outbox
  ADD COLUMN proxima_tentativa_em timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN ultimo_erro text;

-- Inbox: comandos da SAGA processados uma única vez.
CREATE TABLE eventos_processados (
  evento_id     uuid NOT NULL,
  consumidor    text NOT NULL,
  tipo          text NOT NULL,
  processado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (evento_id, consumidor)
);

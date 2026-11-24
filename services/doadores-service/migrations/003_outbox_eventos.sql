-- Parte 4: doadores passa a publicar eventos (Transactional Outbox + relay).
-- doador.cadastrado / doador.atualizado alimentam a réplica de nomes do painel (CQRS) no comunidades-service.
ALTER TABLE outbox
  ADD COLUMN proxima_tentativa_em timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN ultimo_erro text;

-- Backfill: publica os doadores que já existiam antes dos eventos (o relay envia em seguida).
WITH d AS (SELECT gen_random_uuid() AS evento_id, * FROM doadores)
INSERT INTO outbox (id, agregado, agregado_id, tipo, payload)
SELECT d.evento_id, 'doador', d.id, 'doador.cadastrado',
       jsonb_build_object('id', d.evento_id, 'tipo', 'doador.cadastrado', 'ocorridoEm', now(),
                          'dados', jsonb_build_object('doadorId', d.id, 'nome', d.nome, 'cidade', d.cidade, 'uf', d.uf))
  FROM d;

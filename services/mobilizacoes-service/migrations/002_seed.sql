INSERT INTO mobilizacoes (id, comunidade_id, titulo, descricao, data_hora, cidade, uf, hemocentro_id, local, vagas, criador_id) VALUES
  ('44444444-4444-4444-8444-444444444441', '22222222-2222-4222-8222-222222222221',
   'Doação coletiva de dezembro', 'Vamos juntos antes das festas de fim de ano!',
   '2026-12-05 09:00:00-03', 'Lavras', 'MG', '33333333-3333-4333-8333-333333333331',
   'Ponto de coleta de Lavras', 20, '11111111-1111-4111-8111-111111111111');

INSERT INTO interesses (mobilizacao_id, doador_id) VALUES
  ('44444444-4444-4444-8444-444444444441', '11111111-1111-4111-8111-111111111112');

INSERT INTO comunidades (id, nome, descricao, cidade, uf, criador_id, total_mobilizacoes) VALUES
  ('22222222-2222-4222-8222-222222222221', 'Doadores de Lavras', 'Grupo de doadores de sangue de Lavras e região.', 'Lavras', 'MG', '11111111-1111-4111-8111-111111111111', 1),
  ('22222222-2222-4222-8222-222222222222', 'Sangue Bom BH', 'Mobilizações mensais em Belo Horizonte.', 'Belo Horizonte', 'MG', '11111111-1111-4111-8111-111111111113', 0);

INSERT INTO membros (comunidade_id, doador_id, papel) VALUES
  ('22222222-2222-4222-8222-222222222221', '11111111-1111-4111-8111-111111111111', 'admin'),
  ('22222222-2222-4222-8222-222222222221', '11111111-1111-4111-8111-111111111112', 'membro'),
  ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111113', 'admin');

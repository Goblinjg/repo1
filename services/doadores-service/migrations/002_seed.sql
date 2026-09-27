-- Perfis de demonstração (sem senha: não fazem login; servem de dados para os demais serviços).
-- Para logar, cadastre um usuário pela API (ver scripts/smoke-test.sh).
INSERT INTO doadores (id, nome, email, tipo_sanguineo, cidade, uf, data_ultima_doacao) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Ana Souza',    'ana.demo@4life.local',   'O-', 'Lavras',         'MG', '2026-05-10'),
  ('11111111-1111-4111-8111-111111111112', 'Bruno Lima',   'bruno.demo@4life.local', 'A+', 'Lavras',         'MG', NULL),
  ('11111111-1111-4111-8111-111111111113', 'Carla Mendes', 'carla.demo@4life.local', 'B+', 'Belo Horizonte', 'MG', '2026-02-01');

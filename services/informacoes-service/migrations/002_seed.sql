-- Conteúdo ORIENTATIVO de demonstração. Os critérios oficiais podem mudar:
-- o texto sempre orienta o usuário a confirmar com o hemocentro.
INSERT INTO conteudos (slug, titulo, categoria, resumo, corpo) VALUES
  ('quem-pode-doar', 'Quem pode doar sangue?', 'requisitos',
   'Idade, peso e condições gerais para doar.',
   'Em geral, podem doar pessoas entre 16 e 69 anos (menores de 18 com autorização do responsável), com pelo menos 50 kg e em boas condições de saúde. Há regras específicas para primeira doação após os 60 anos e intervalos mínimos entre doações. Confirme sempre os critérios atualizados com o hemocentro.'),
  ('antes-de-doar', 'Como se preparar para a doação', 'preparo',
   'Descanso, alimentação e hidratação.',
   'Durma bem na noite anterior, não vá em jejum, evite alimentos gordurosos nas horas que antecedem a doação, beba bastante água e evite bebidas alcoólicas nas 12 horas anteriores.'),
  ('documentos', 'Quais documentos levar', 'documentos',
   'Documento oficial com foto.',
   'Leve um documento oficial com foto (RG, CNH, carteira de trabalho, passaporte ou equivalente). Menores de idade precisam da autorização e da presença de um responsável, conforme as regras do hemocentro.'),
  ('mito-engorda', 'Mito: doar sangue engorda ou emagrece', 'mitos',
   'A doação não altera o peso.',
   'A doação não provoca ganho nem perda de peso. O volume doado é reposto naturalmente pelo organismo.'),
  ('mito-pega-doenca', 'Mito: é possível pegar doenças ao doar', 'mitos',
   'Todo o material é descartável.',
   'Todo o material utilizado na coleta é estéril e descartável, usado uma única vez. Não há risco de contrair doenças ao doar.'),
  ('mito-vicia', 'Mito: quem doa uma vez precisa doar sempre', 'mitos',
   'A doação não cria dependência.',
   'Doar sangue não "vicia" nem obriga o organismo a doações futuras. Doar com regularidade é uma escolha, e é muito bem-vinda.'),
  ('dica-hidratacao', 'Hidrate-se antes e depois', 'dica',
   'Água ajuda na recuperação.',
   'Beba bastante água no dia da doação e nas horas seguintes.'),
  ('dica-convide', 'Convide alguém para doar com você', 'dica',
   'Mobilizações em grupo aumentam a participação.',
   'Ir acompanhado reduz a ansiedade de quem doa pela primeira vez. Crie ou participe de uma mobilização da sua comunidade!'),
  ('dica-esforco', 'Evite esforço físico após a doação', 'dica',
   'Descanse no restante do dia.',
   'Após doar, evite atividades físicas intensas e siga as orientações da equipe do hemocentro.');

INSERT INTO faq (pergunta, resposta, categoria, ordem) VALUES
  ('Quanto tempo leva a doação?', 'A coleta em si leva poucos minutos; o processo completo (cadastro, triagem, coleta e lanche) costuma levar cerca de uma hora.', 'preparo', 1),
  ('Com que frequência posso doar?', 'Há intervalos mínimos entre doações, diferentes para homens e mulheres. Consulte o hemocentro para os valores vigentes.', 'requisitos', 2),
  ('Dói doar sangue?', 'Sente-se apenas a picada da agulha. A maioria das pessoas relata desconforto mínimo.', 'mitos', 3),
  ('Preciso estar em jejum?', 'Não. Pelo contrário: alimente-se de forma leve antes de doar.', 'preparo', 4),
  ('Quem tem tatuagem pode doar?', 'Pode, desde que respeitado o prazo definido pelas normas vigentes após a tatuagem. Confirme com o hemocentro.', 'requisitos', 5);

-- Hemocentros ILUSTRATIVOS (não representam endereços reais).
INSERT INTO hemocentros (id, nome, cidade, uf, endereco, telefone, horarios) VALUES
  ('33333333-3333-4333-8333-333333333331', 'Ponto de coleta de Lavras (exemplo)', 'Lavras', 'MG', 'Endereço ilustrativo, Centro', NULL, 'Seg a sex, 7h às 12h'),
  ('33333333-3333-4333-8333-333333333332', 'Hemocentro de Belo Horizonte (exemplo)', 'Belo Horizonte', 'MG', 'Endereço ilustrativo, Centro', NULL, 'Seg a sáb, 7h às 18h'),
  ('33333333-3333-4333-8333-333333333333', 'Hemocentro de Varginha (exemplo)', 'Varginha', 'MG', 'Endereço ilustrativo, Centro', NULL, 'Seg a sex, 7h às 13h');

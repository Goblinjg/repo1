# CQRS do painel de comunidades — desenho-alvo

## Por que separar leitura e escrita

O `comunidades-service` é o candidato a CQRS porque o painel web combina
comunidade, membros, nomes de doadores e mobilizações. Hoje essa composição gera
fan-out de chamadas entre serviços (inclusive uma consulta por membro). A
escrita, feita com menor frequência, precisa manter comunidades e membros em
modelo normalizado; a leitura frequente se beneficia de um documento pronto para
a tela.

## Modelos e atualização

- **Escrita:** tabelas normalizadas `comunidades` e `membros`. Regras de
  autorização, incluindo o papel de admin, sempre consultam esse modelo.
- **Leitura:** projeção `painel_comunidade` com dados da comunidade, membros
  (`doadorId`, nome e papel), próximas mobilizações, `versao` e `atualizadoEm`.
- **Atualização:** consumidores idempotentes aplicam `comunidade.criada`,
  `membro.entrou`, `membro.saiu`, `mobilizacao.criada`,
  `mobilizacao.cancelada` e `doador.atualizado`. Eventos publicados pelo próprio
  serviço usam Transactional Outbox; os de outros serviços também devem chegar
  por suas outboxes.
- **Defasagem aceitável:** até 5 segundos em operação normal. A resposta inclui
  `atualizadoEm`; autorização nunca depende da projeção eventualmente consistente.
- **Recuperação:** a projeção é reconstruível pelo reprocessamento dos eventos.

O modelo reduz o fan-out para a leitura do painel, sem enfraquecer as decisões
transacionais de escrita e autorização. A especificação e o diagrama estão em
[`docs/pitch/pitch-parte2.md`](../../../../docs/pitch/pitch-parte2.md), seção 7.0.

## Estado do protótipo

`modelo-leitura.ts` contém apenas interfaces de contrato. A tabela de projeção,
os consumidores, o endpoint de consulta e a publicação por outbox **ainda não
estão implementados**.

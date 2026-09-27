# ADR-0004 — Mensageria com RabbitMQ

**Status:** aceito

## Contexto
Algumas reações entre domínios não precisam ser síncronas. Exemplo: atualizar o
contador de mobilizações da comunidade.

## Decisão
- RabbitMQ com exchange *topic* `4life.events`.
- Uma fila durável por consumidor e mensagens persistentes.
- Ack manual e consumidor idempotente (tabela `eventos_processados`).
- **Parte 3:** o evento é publicado após o commit.
- **Parte 4:** a publicação passa a usar **Transactional Outbox**. A tabela
  `outbox` já existe em todos os bancos.

## Consequências
- Na Parte 3 existe uma janela em que o commit ocorre e a publicação falha
  (evento perdido). Essa janela é aceita e documentada, e é resolvida pelo outbox
  na Parte 4.

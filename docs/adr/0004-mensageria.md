# ADR-0004 — Mensageria com RabbitMQ

**Status:** aceito

## Contexto
Algumas reações entre domínios não precisam ser síncronas. Exemplo: atualizar o
contador de mobilizações da comunidade.

## Decisão
- RabbitMQ com exchange *topic* `4life.events`; a routing key é o tipo da mensagem.
- Uma fila durável por consumidor e mensagens persistentes.
- Ack manual e consumidor idempotente (`eventos_processados (evento_id, consumidor)`).
- **Transactional Outbox (implementado na Parte 4):** o evento (ou comando da SAGA) é
  gravado na tabela `outbox` na mesma transação local da alteração de domínio. Um
  relay por serviço publica as pendências com `FOR UPDATE SKIP LOCKED`, espera o
  publisher confirm, marca `publicado_em` e, em falha, re-tenta com backoff.
- Todo serviço declara a topologia completa (filas e bindings) ao conectar.
- Além de eventos de integração, o broker transporta os **comandos e respostas da
  SAGA** orquestrada (`saga.*`).

> Histórico: até a Parte 3, o evento era publicado após o commit, com uma
> gravação de fallback na outbox **separada** da transação de domínio (não
> atômica). Isso foi substituído pelo outbox transacional.

## Consequências
- Não há mais dual write entre banco e broker: se o processo cair depois do
  commit, a mensagem continua na outbox e o relay a publica depois.
- A entrega é *at-least-once*; o consumidor idempotente garante efeito único.
- O broker deixou de ser requisito de prontidão dos publicadores: sem ele, as
  mensagens acumulam na outbox.
- Custo: latência extra de até um ciclo do relay (500 ms) e uma tabela a mais
  para limpar (mensagens publicadas há mais de 7 dias são apagadas).

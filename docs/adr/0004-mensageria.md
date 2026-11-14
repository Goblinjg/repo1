# ADR-0004 — Mensageria com RabbitMQ

**Status:** aceito

## Contexto
Algumas reações entre domínios não precisam ser síncronas. Exemplo: atualizar o
contador de mobilizações da comunidade.

## Decisão
- RabbitMQ com exchange *topic* `4life.events`.
- Uma fila durável por consumidor e mensagens persistentes.
- Ack manual e consumidor idempotente (tabela `eventos_processados`).
- **Protótipo atual:** o evento é publicado após o commit. Se a publicação falha,
  o código tenta inserir uma linha na outbox como fallback. Essa escrita é
  posterior e separada da transação de domínio; portanto não é Transactional
  Outbox e ainda pode perder evento se o processo cair entre as escritas.
- **Desenho-alvo:** inserir o evento na outbox na mesma transação local da
  alteração de domínio e usar um relay com publisher confirm para publicá-lo.
  A tabela `outbox` já existe em todos os bancos, mas o relay ainda não está
  implementado.

## Consequências
- No protótipo existe uma janela em que o commit ocorre e a publicação falha; o
  fallback reduz alguns casos, mas não fecha a janela porque não é atômico. O
  desenho-alvo de outbox transacional elimina o dual write entre banco e broker.

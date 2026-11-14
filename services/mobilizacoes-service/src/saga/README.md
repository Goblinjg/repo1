# SAGA de criação de mobilização — desenho-alvo

## Decisão

O fluxo usa SAGA **orquestrada**, coordenada pelo `mobilizacoes-service`. Com
três serviços participantes e compensações dependentes da ordem, o estado
persistido em um coordenador facilita acompanhamento, retentativas e diagnóstico.
Na coreografia, o progresso e as compensações ficariam distribuídos entre os
consumidores, aumentando o esforço para reconstruir o estado do fluxo.

## Transação de negócio

Criar uma mobilização confirmada atravessa `mobilizacoes-service`,
`comunidades-service` e `informacoes-service`:

1. **T1 — mobilizacoes:** grava mobilização `PENDENTE` e registro da saga.
2. **T2 — comunidades:** valida que o criador é admin e reserva a data no
   calendário da comunidade.
3. **T3 — informacoes:** reserva capacidade do hemocentro para a janela solicitada.
4. **T4 — mobilizacoes:** muda o estado para `CONFIRMADA` e grava
   `mobilizacao.criada` na outbox.

Os comandos e respostas trafegam pelo RabbitMQ e são publicados pela outbox.
Cada participante deduplica comandos por `sagaId`. A criação responde `202
Accepted`; o cliente consulta o recurso enquanto a saga está em andamento.

## Compensações

| Passo | Compensação | Regra |
|---|---|---|
| T1 | **C1:** marca mobilização `CANCELADA` e registra o motivo | Executada quando algum passo anterior ao pivô falha |
| T2 | **C2:** remove reserva do calendário por `sagaId` | Idempotente; chamada repetida não altera o resultado |
| T3 | **C3:** remove reserva de capacidade do hemocentro por `sagaId` | Idempotente; chamada repetida não altera o resultado |
| T4 | Sem compensação; é repetido até concluir | Após T3 bem-sucedido, o fluxo segue para frente |

Depois de T3, considerado o pivô, o coordenador não desfaz as reservas: ele
retenta T4 até confirmar. Antes do pivô, uma falha dispara as compensações em
ordem reversa. Falhas e timeouts de compensação são persistidos e retentados.

## Cenários documentados

- **Caminho feliz:** T1 → T2 → T3 → T4 → `CONCLUIDA`.
- **Hemocentro sem capacidade:** T1 → T2 → falha em T3 → C2 → C1 → `COMPENSADA`.
- **Criador não é admin:** T1 → falha em T2 → C1 → `COMPENSADA`.

Os diagramas de sequência e detalhes das filas estão em
[`docs/pitch/pitch-parte2.md`](../../../../docs/pitch/pitch-parte2.md), seções
6.0–6.3. Os tipos em `contratos.ts` são interfaces de intenção: a saga, as
transações locais, as filas e as compensações **ainda não estão implementadas**.

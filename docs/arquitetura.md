# 4Life — Arquitetura (Parte 2)

> Este documento é a **fonte da verdade** da arquitetura do 4Life. Os contratos
> detalhados de cada componente estão em [`docs/api/`](api/) e as decisões em
> [`docs/adr/`](adr/).

## 1. Visão geral

```text
                 Clientes: app mobile  ·  aplicação web
                                 │
                          ┌──────▼──────┐
                          │ API Gateway │  autenticação JWT, roteamento por prefixo,
                          │   :8080     │  remoção de cabeçalhos internos
                          └──┬───────┬──┘
              /api/mobile/*  │       │  /api/web/*   (+ /auth/login)
                     ┌───────▼──┐ ┌──▼───────┐
                     │bff-mobile│ │ bff-web  │  agregação e formatação por cliente
                     │  :4001   │ │  :4002   │
                     └────┬─────┘ └────┬─────┘
         ┌─────────────┬──┴──────────┬─┴────────────┐
   ┌─────▼─────┐ ┌─────▼──────┐ ┌────▼───────┐ ┌────▼───────┐
   │ doadores  │ │comunidades │ │mobilizacoes│ │informacoes │  serviços de domínio
   │  :3001    │ │   :3002    │ │   :3003    │ │   :3004    │
   └─────┬─────┘ └──┬──────▲──┘ └──┬─────┬───┘ └────┬───────┘
         │          │      │ consome│     │publica   │
     doadores-db  comunidades-db  mobilizacoes-db  informacoes-db   (PostgreSQL, 1 por serviço)
                           │        │
                        ┌──┴────────▼──┐
                        │   RabbitMQ   │  exchange topic `4life.events`
                        └──────────────┘
```

## 2. Decomposição em serviços

| Serviço | Responsabilidade | Dados próprios | Porta |
|---|---|---|---|
| **doadores-service** | Cadastro e perfil de doadores; verificação de credenciais | `doadores` | 3001 |
| **comunidades-service** | Comunidades, membros e papéis (admin/membro); contador de mobilizações | `comunidades`, `membros`, `eventos_processados` | 3002 |
| **mobilizacoes-service** | Mobilizações (eventos de doação) e interesses dos usuários | `mobilizacoes`, `interesses` | 3003 |
| **informacoes-service** | Conteúdos educativos, FAQ e hemocentros (orientativo) | `conteudos`, `faq`, `hemocentros` | 3004 |

Regras:
- **Database per service**: cada serviço tem sua própria instância PostgreSQL e
  nenhum outro componente acessa esse banco (ver ADR-0002).
- Referências entre domínios são feitas **por identificador** (ex.:
  `mobilizacoes.comunidade_id`), sem chave estrangeira entre bancos.
- Todos os serviços expõem `GET /health` (liveness: processo vivo) e
  `GET /ready` (readiness: banco respondendo).
- Todos os bancos já possuem a tabela `outbox`, que será usada pelo padrão
  Transactional Outbox na Parte 4.

## 3. API Gateway

Ponto de entrada único (ADR-0003). Responsabilidades:

| Rota pública | Destino | Autenticação |
|---|---|---|
| `POST /auth/login` | gateway → `bff-web /auth/verificar-credenciais`; o **gateway assina o JWT** | pública |
| `POST /api/{mobile,web}/cadastro` | BFF correspondente | pública |
| `GET  /api/{mobile,web}/info/**` | BFF correspondente | pública |
| `GET  /api/mobile/diagnostico/whoami` | bff-mobile → mobilizacoes `/whoami` | pública (diagnóstico) |
| `/api/mobile/**` | bff-mobile | **JWT obrigatório** |
| `/api/web/**` | bff-web | **JWT obrigatório** |

- JWT HS256, validade de 1 h, `sub` = id do doador, segredo em `JWT_SECRET`
  (somente o gateway conhece o segredo).
- O gateway **remove** qualquer `x-user-*` vindo do cliente e injeta
  `x-user-id`/`x-user-nome` a partir do token validado. Os componentes internos
  confiam nesses cabeçalhos porque só são alcançáveis pela rede interna.

## 4. BFFs (Backend for Frontend)

| BFF | Cliente | Exemplos de agregação |
|---|---|---|
| **bff-mobile** | app mobile (telas curtas, poucos campos) | `GET /inicio` = próximas mobilizações + minhas comunidades + dica do dia |
| **bff-web** | aplicação web (painéis, administração de comunidades) | `GET /painel`, `GET /comunidades/{id}` = comunidade + membros + mobilizações; criação de mobilização valida se o usuário é admin da comunidade |

Os BFFs não têm banco. Eles orquestram chamadas HTTP síncronas aos serviços e
degradam graciosamente (campo `null` + aviso) se um serviço secundário falhar.

## 5. Comunicação assíncrona (eventos)

Broker: **RabbitMQ**, exchange `4life.events` do tipo *topic*, mensagens JSON
persistentes (ADR-0004).

| Evento | Publicador | Consumidores | Efeito |
|---|---|---|---|
| `mobilizacao.criada` | mobilizacoes-service | comunidades-service (fila `comunidades.mobilizacao-criada`) | incrementa `comunidades.total_mobilizacoes` |
| `mobilizacao.interesse-registrado` | mobilizacoes-service | — (reservado Parte 4) | — |

Envelope:
```json
{ "id": "uuid", "tipo": "mobilizacao.criada", "ocorridoEm": "ISO-8601",
  "dados": { "mobilizacaoId": "uuid", "comunidadeId": "uuid", "dataHora": "ISO-8601" } }
```

- Consumo com *ack* manual e **idempotente** (tabela `eventos_processados`).
- A fila e o binding são declarados pelo consumidor **e** pelo publicador
  (idempotente), para que nenhum evento publicado antes de o consumidor subir
  seja descartado.
- O `/ready` do mobilizacoes-service inclui a conexão com o broker.
- Na Parte 3 a publicação é feita logo após o commit da transação. Na Parte 4
  ela passa a ser feita via **outbox + relay** (tabela já criada).

## 6. Evolução planejada (Parte 4, apenas estrutura)

- **SAGA** — `mobilizacoes-service/src/saga/`: criação de mobilização
  coordenada com comunidades (reserva/compensação).
- **CQRS** — `comunidades-service/src/cqrs/`: modelo de leitura desnormalizado
  para o painel.
- **Outbox** — tabela `outbox` em todos os bancos + interface `OutboxRelay`.

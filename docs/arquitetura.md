# 4Life — Arquitetura

> Este documento é a **fonte da verdade do desenho arquitetural** do 4Life. Os
> contratos detalhados estão em [`docs/api/`](api/) e as decisões em
> [`docs/adr/`](adr/). O código é um protótipo parcial: cada seção distingue o
> desenho-alvo do que já existe, sem tratar estruturas reservadas como recursos
> implementados.

## 1. Visão geral

```text
                 Clientes: app mobile  ·  aplicação web
                                 │
                          ┌──────▼──────┐
                          │ API Gateway │  autenticação JWT, roteamento por prefixo,
                          │   :8080     │  remoção de cabeçalhos internos
                          └──┬───────┬──┘
       /api/v1/mobile/*     │       │  /api/v1/web/* (+ /auth/login)
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
- A superfície pública alvo é versionada por URI (`/api/v1/mobile` e
  `/api/v1/web`). O protótipo atual ainda aceita `/api/mobile` e `/api/web`;
  essa diferença é registrada nos contratos e não significa que o prefixo
  versionado já esteja implantado.
- **Database per service**: cada serviço tem sua própria instância PostgreSQL e
  nenhum outro componente acessa esse banco (ver ADR-0002).
- Referências entre domínios são feitas **por identificador** (ex.:
  `mobilizacoes.comunidade_id`), sem chave estrangeira entre bancos.
- Todos os serviços expõem `GET /health` (liveness: processo vivo) e
  `GET /ready` (readiness: banco respondendo).
- Todos os bancos possuem uma tabela `outbox`, mas a tabela por si só não
  implementa o padrão Transactional Outbox. O fluxo transacional descrito em
  §7 é o desenho-alvo; o relay e a gravação atômica ainda estão pendentes.

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

No desenho-alvo, os prefixos de cliente incluem a versão: `/api/v1/mobile/**`
e `/api/v1/web/**`. As rotas sem `/v1` acima são as rotas do protótipo atual.
O versionamento usa major no caminho; mudanças aditivas permanecem na mesma
versão. Uma versão substituída será sinalizada com `Deprecation` e `Sunset`,
com período de convivência compatível com a atualização dos apps móveis.

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

As respostas são específicas por cliente: o mobile recebe cards compactos e
respostas agregadas para reduzir chamadas e tráfego; a web recebe detalhes
enriquecidos para painéis e administração. Exemplos completos e o recurso
Mobilização com `_links` HATEOAS estão em [`pitch-parte2.md`](pitch/pitch-parte2.md).
O HATEOAS e o prefixo `/v1` fazem parte do contrato arquitetural-alvo, ainda não
do protótipo executável.

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
- **Protótipo atual:** publica após o commit e, se a publicação falhar, grava
  uma linha de fallback na outbox. Há risco de perda se o processo cair entre o
  commit do domínio e a publicação; a gravação de fallback também não é atômica.
- **Desenho-alvo:** grava a mudança de domínio e o evento na outbox na mesma
  transação local; um relay publica com confirmação e marca a linha como
  publicada. O consumidor continua idempotente para tolerar reentregas.

## 6. SAGA orquestrada (desenho-alvo)

- Uma transação de negócio cria uma mobilização confirmada através de
  `mobilizacoes-service`, `comunidades-service` e `informacoes-service`.
- O orquestrador vive em `mobilizacoes-service`, persiste o estado da saga e
  envia comandos/respostas pelo RabbitMQ. A escolha é orquestração porque há
  três participantes e compensações ordenadas que precisam ser observáveis num
  único fluxo.
- Passos: (T1) cria mobilização `PENDENTE` e saga; (T2) comunidades valida o
  papel de admin e reserva a data; (T3) informações reserva capacidade do
  hemocentro; (T4) mobilizações confirma e grava `mobilizacao.criada` na outbox.
- Compensações: C1 marca a mobilização como `CANCELADA` com motivo; C2 remove a
  reserva comunitária por `sagaId`; C3 remove a reserva do hemocentro por
  `sagaId`. São idempotentes e reexecutadas em caso de falha. Depois do passo
  pivô T3, T4 é retentado até concluir.
- Caminho feliz, falha por capacidade indisponível, timeout e contratos estão
  detalhados em [`pitch-parte2.md`](pitch/pitch-parte2.md). O código atual
  contém somente interfaces de contrato; o orquestrador e os comandos não estão
  implementados.

## 7. Transactional Outbox (desenho-alvo)

No fluxo `mobilizacao.criada`, o serviço grava mobilização e evento na tabela
`outbox` **na mesma transação PostgreSQL**. Um relay seleciona pendências com
`FOR UPDATE SKIP LOCKED`, publica mensagem persistente no RabbitMQ, aguarda
publisher confirm e marca a linha como publicada. A entrega é *at-least-once*;
`eventos_processados` faz o consumidor idempotente. Assim, não há dual write
entre a transação de negócio e a intenção de publicar. O protótipo atual ainda
usa publicação direta com fallback não atômico, conforme §5.

## 8. CQRS — painel de comunidades (desenho-alvo)

O `comunidades-service` mantém o modelo normalizado de escrita e uma projeção
desnormalizada de leitura para o painel (comunidade, membros com nome e
próximas mobilizações). A projeção é atualizada idempotentemente por eventos e
é reconstruível. A defasagem aceitável é de até 5 segundos; decisões de
autorização continuam consultando o modelo de escrita. A separação reduz o
fan-out N+1 do painel web sem colocar autorização em dados eventualmente
consistentes. Hoje há somente interfaces de contrato em `src/cqrs/`.

## 9. Estado de implementação

| Capacidade | Estado do protótipo |
|---|---|
| Quatro serviços, gateway e dois BFFs | Implementados parcialmente; ver rotas e contratos OpenAPI |
| Versão URI `/api/v1` | Decidida para a borda; protótipo ainda usa `/api/{mobile,web}` |
| HATEOAS para Mobilização | Projetado no contrato arquitetural; não emitido pelo código atual |
| Rate limiting | Responsabilidade planejada, ainda não implementada |
| Database per service e consumidor idempotente | Implementados |
| Transactional Outbox + relay | Desenhado; código atual usa publicação direta e fallback não atômico |
| SAGA orquestrada de três serviços | Modelada; apenas contratos parciais no código |
| CQRS do painel | Modelado; apenas interfaces no código |

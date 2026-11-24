# 4Life — Arquitetura

> Este documento é a **fonte da verdade do desenho arquitetural** do 4Life. Os
> contratos detalhados estão em [`docs/api/`](api/) e as decisões em
> [`docs/adr/`](adr/). O código é um protótipo parcial: cada seção distingue o
> desenho-alvo do que já existe, sem tratar estruturas reservadas como recursos
> implementados.
>
> **Diagrama único com todos os componentes:** [`diagrama-completo.md`](diagrama-completo.md).

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
                        └──────────────┘  (eventos via outbox + comandos/respostas da SAGA)
```

Além disso, o `informacoes-service` usa um **LLM local (Ollama)** no assistente com RAG,
e o `informacoes-db` tem a extensão **pgvector** (§9).

## 2. Decomposição em serviços

| Serviço | Responsabilidade | Dados próprios | Porta |
|---|---|---|---|
| **doadores-service** | Cadastro e perfil de doadores; verificação de credenciais; publica `doador.*` | `doadores`, `outbox` | 3001 |
| **comunidades-service** | Comunidades, membros e papéis; participante da SAGA (T2/C2); **CQRS** do painel | `comunidades`, `membros`, `reservas_calendario`, `painel_comunidade` (+ réplicas `doadores_nomes`, `mobilizacoes_resumo`), `eventos_processados`, `outbox` | 3002 |
| **mobilizacoes-service** | Mobilizações e interesses; **orquestrador da SAGA** | `mobilizacoes`, `interesses`, `sagas`, `saga_historico`, `eventos_processados`, `outbox` | 3003 |
| **informacoes-service** | Conteúdos, FAQ e hemocentros; participante da SAGA (T3/C3); **assistente com RAG** | `conteudos`, `faq`, `hemocentros`, `reservas_hemocentro`, `rag_trechos` (pgvector), `assistente_cache`, `eventos_processados`, `outbox` | 3004 |

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
- Todo serviço que publica mensagens usa **Transactional Outbox**: o evento é
  gravado na tabela `outbox` na mesma transação da mudança de domínio, e um
  relay publica no RabbitMQ (§7).

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
| **bff-web** | aplicação web (painéis, administração de comunidades) | `GET /painel`; `GET /comunidades/{id}` lê o **modelo de leitura** (CQRS) numa chamada; criação de mobilização valida se o usuário é admin e devolve `202` (SAGA) |

Os BFFs não têm banco. Eles orquestram chamadas HTTP síncronas aos serviços e
degradam graciosamente (campo `null` + aviso) se um serviço secundário falhar.

As respostas são específicas por cliente: o mobile recebe cards compactos e
respostas agregadas para reduzir chamadas e tráfego; a web recebe detalhes
enriquecidos para painéis e administração. Exemplos completos e o recurso
Mobilização com `_links` HATEOAS estão em [`pitch-parte2.md`](pitch/pitch-parte2.md).
O HATEOAS e o prefixo `/v1` fazem parte do contrato arquitetural-alvo, ainda não
do protótipo executável.

## 5. Comunicação assíncrona (eventos e comandos)

Broker: **RabbitMQ**, exchange `4life.events` do tipo *topic*, mensagens JSON
persistentes (ADR-0004). A routing key é o tipo da mensagem.

| Mensagem | Publicador | Fila consumidora | Efeito |
|---|---|---|---|
| `doador.cadastrado`, `doador.atualizado` | doadores | `comunidades.painel` | réplica de nomes do painel (CQRS) |
| `comunidade.criada`, `membro.entrou`, `membro.saiu` | comunidades | `comunidades.painel` | remonta o documento do painel |
| `mobilizacao.criada` | mobilizacoes (T4) | `comunidades.mobilizacao-criada`, `comunidades.painel` | contador `total_mobilizacoes`; próximas mobilizações no painel |
| `mobilizacao.cancelada` | mobilizacoes (C1) | `comunidades.painel` | tira a mobilização do painel |
| `mobilizacao.sincronizada` | mobilizacoes (migração) | `comunidades.painel` | carga inicial das mobilizações anteriores ao CQRS |
| `mobilizacao.interesse-registrado` | mobilizacoes | — (reservado) | — |
| `saga.comunidades.reservar-data` / `liberar-data` | orquestrador | `saga.comunidades.comandos` | T2 / C2 |
| `saga.informacoes.reservar-janela` / `liberar-janela` | orquestrador | `saga.informacoes.comandos` | T3 / C3 |
| `saga.resposta.*` (`data-reservada`, `janela-recusada`, …) | participantes | `saga.mobilizacoes.respostas` | avança ou compensa a saga |

Envelope (eventos e comandos):
```json
{ "id": "uuid", "tipo": "mobilizacao.criada", "ocorridoEm": "ISO-8601",
  "dados": { "mobilizacaoId": "uuid", "comunidadeId": "uuid", "titulo": "…", "dataHora": "ISO-8601" } }
```

- Consumo com *ack* manual e **idempotente**: `eventos_processados (evento_id, consumidor)`
  na mesma transação do efeito; o mesmo evento pode alimentar mais de um consumidor.
- Todo serviço declara a **topologia completa** (filas e bindings) ao conectar,
  para que nenhuma mensagem se perca por causa da ordem em que os serviços sobem.
- Filas da SAGA e do painel usam `prefetch 1`: a ordem da fila é preservada
  (ex.: `reservar-janela` é sempre processado antes do `liberar-janela` da mesma saga).
- O broker **não** é mais requisito de prontidão: sem ele, as mensagens ficam na
  outbox e o relay publica quando a conexão voltar.

## 6. SAGA orquestrada — criar mobilização confirmada

- O orquestrador vive em `mobilizacoes-service` (`src/saga/orquestrador.ts`),
  persiste o estado em `sagas` e a linha do tempo em `saga_historico`, e conversa
  com os participantes **só por comandos/respostas no RabbitMQ**, publicados pela
  outbox na mesma transação que muda o estado da saga. A escolha é orquestração
  porque há três participantes e compensações que dependem da ordem e precisam
  ser observáveis num único fluxo.
- Passos: (T1) cria mobilização `PENDENTE` + saga e responde **202**; (T2)
  comunidades valida admin **no modelo de escrita** e reserva a data
  (`reservas_calendario`, no máximo uma por comunidade e dia); (T3) informações reserva uma janela
  do hemocentro (`reservas_hemocentro`, limitada por `capacidade_diaria`; é o **pivô**); (T4)
  mobilizações marca `CONFIRMADA` e grava `mobilizacao.criada` na outbox. Sem
  hemocentro informado, a saga vai de T2 direto para T4.
- Compensações em ordem reversa: C3 libera a janela, C2 libera a data e C1 marca a
  mobilização como `CANCELADA` com o motivo. Todas são idempotentes (por `saga_id`).
- **Timeout:** passo sem resposta em `SAGA_TIMEOUT_MS` (30 s) é tratado como falha.
  Como o participante pode ter executado sem responder, o passo atual também
  entra na fila de compensação. Compensações sem confirmação são **reenviadas** a
  cada prazo; depois de `SAGA_MAX_TENTATIVAS` a saga vai para `FALHOU` (intervenção manual).
- Respostas que chegam fora de hora (ex.: depois de um timeout) são registradas
  como ignoradas e não mudam o estado.
- O monitor de prazos usa `FOR UPDATE SKIP LOCKED`, então várias réplicas do
  mobilizacoes-service podem rodar sem tratar a mesma saga duas vezes.
- Acompanhamento: `GET /api/web/mobilizacoes/{id}/saga` devolve o estado e o histórico.

Cenários verificados (roteiro em `scripts/demo-parte4.sh`):

| Cenário | Sequência |
|---|---|
| Caminho feliz | T1 → T2 → T3 → T4 → `CONCLUIDA` |
| Hemocentro sem capacidade | T1 → T2 → T3 recusado → C2 → C1 → `COMPENSADA` |
| Comunidade já tem mobilização no dia / criador não é admin | T1 → T2 recusado → C1 → `COMPENSADA` |
| informacoes-service fora do ar | T1 → T2 → timeout em T3 → C3 (espera o serviço voltar) → C2 → C1 → `COMPENSADA` |

## 7. Transactional Outbox

Quem muda o domínio grava a mensagem na tabela `outbox` **na mesma transação
PostgreSQL** (`gravarNaOutbox`). Um relay em cada serviço publicador
(`src/outbox/relay.ts`), a cada 500 ms:

1. seleciona até 50 pendências com `FOR UPDATE SKIP LOCKED` (réplicas não publicam em duplicidade);
2. publica cada uma como mensagem persistente e espera o **publisher confirm**;
3. marca `publicado_em`. Em falha, incrementa `tentativas`, grava `ultimo_erro`
   e agenda `proxima_tentativa_em` com backoff exponencial (até 30 s). O lote
   para na primeira falha, para preservar a ordem.

Mensagens publicadas há mais de 7 dias são apagadas. A entrega é
*at-least-once*; o consumidor idempotente garante efeito único. Não existe mais
*dual write* entre a transação de negócio e a publicação.

## 8. CQRS — painel da comunidade

- **Escrita:** tabelas normalizadas `comunidades` e `membros`. Cada escrita grava
  `comunidade.criada`, `membro.entrou` ou `membro.saiu` na outbox.
- **Leitura:** `painel_comunidade (comunidade_id, documento jsonb, versao, atualizado_em)`:
  comunidade, membros com **nome** e papel, total de mobilizações confirmadas e as
  próximas mobilizações. É um documento pronto para a tela.
- **Atualização:** a projeção (`src/cqrs/modelo-leitura.ts`) consome a fila
  `comunidades.painel`, atualiza as réplicas locais (`doadores_nomes`,
  `mobilizacoes_resumo`) e remonta o documento de cada comunidade afetada,
  incrementando a `versao`. É idempotente e **reconstruível**
  (`POST /comunidades/painel/reconstruir`; no boot, comunidades sem documento ganham um).
- **Consulta:** `GET /comunidades/{id}/painel` lê só o documento. O bff-web usa
  essa consulta em `GET /api/web/comunidades/{id}` (`fonte: "modelo-de-leitura"`),
  trocando o fan-out N+1 anterior (comunidade + membros + uma chamada ao doadores
  por membro) por **uma chamada**. Se a projeção ainda não existir, ele cai na
  composição antiga.
- **Defasagem medida:** ~0,4–0,5 s entre o evento e o documento atualizado
  (log `projeção do painel atualizada`, campo `defasagemMs`); aceitável até 5 s.
  Autorização (é admin?) **nunca** usa a projeção.

## 9. Assistente com LLM (RAG)

O `informacoes-service` responde dúvidas do doador com **RAG** sobre uma base de
conhecimento própria (pgvector no `informacoes-db`), usando **LangChain**
(chains LCEL + tools que consultam hemocentros e janelas reservadas pela SAGA) e
um **LLM local** (Ollama, `qwen2.5:0.5b`; embeddings `bge-m3`). O LLM é tratado
como dependência remota falível: timeout + retry com backoff, circuit breaker,
cache por chave e semântico, e fallback sem LLM. Detalhes em
[`docs/llm/README.md`](llm/README.md); avaliação com e sem recuperação em
[`docs/llm/avaliacao-rag.md`](llm/avaliacao-rag.md); decisão no ADR-0005.

## 10. Estado de implementação

| Capacidade | Estado do protótipo |
|---|---|
| Quatro serviços, gateway e dois BFFs | Implementados; ver rotas e contratos OpenAPI |
| Versão URI `/api/v1` | Decidida para a borda; protótipo ainda usa `/api/{mobile,web}` |
| HATEOAS para Mobilização | `_links` (`self`, `saga`) na resposta 202 da criação; o restante do contrato ainda não é emitido |
| Rate limiting | Responsabilidade planejada, ainda não implementada |
| Database per service e consumidor idempotente | Implementados |
| Transactional Outbox + relay | **Implementado** em doadores, comunidades, mobilizacoes e informacoes |
| SAGA orquestrada de três serviços | **Implementada** (caminho feliz, recusa, timeout e compensações) |
| CQRS do painel | **Implementado** (projeção por eventos, consulta em 1 chamada) |
| Assistente com RAG, LangChain e LLM resiliente | **Implementado** (Ollama local, pgvector, 4 mecanismos de resiliência) |

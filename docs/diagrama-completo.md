# 4Life — Diagrama completo da arquitetura

Um único diagrama com **todos** os componentes do sistema: clientes, borda, gateway, BFFs, os quatro
serviços de domínio com seus componentes internos (rotas, orquestrador da SAGA, outbox e relay,
consumidor idempotente, modelo de leitura do CQRS), bancos, broker, filas e os recursos do Kubernetes
que sustentam cada peça (Ingress, Services, Deployments, StatefulSets/PVCs, ConfigMaps, Secrets, HPA e
NetworkPolicies).

**Como ler:**

| Traço | Significado |
|---|---|
| `──▶` seta cheia | chamada **síncrona** HTTP/JSON |
| `-·-▶` seta pontilhada | mensagem **assíncrona** via RabbitMQ (evento, comando ou resposta) |
| `══` seta grossa | acesso ao **banco** (SQL) ou montagem de volume |
| caixa verde | implementado e rodando no protótipo |
| caixa amarela tracejada | desenho-alvo (Parte 4): contrato definido, implementação pendente |
| caixa cinza | recurso de infraestrutura (Kubernetes / Docker) |

```mermaid
flowchart TB
    %% ================================================================ CLIENTES
    subgraph CLI["Clientes"]
        APP["📱 App mobile"]
        WEB["🖥️ Aplicação web<br/>(doadores e admins de comunidade)"]
    end

    %% ================================================================ CLUSTER
    subgraph K8S["Cluster Kubernetes (kind) · namespace 4life · NetworkPolicy default-deny-ingress"]
        direction TB

        %% ------------------------------------------------------------ BORDA
        subgraph EDGE["Borda"]
            ING["Ingress 4life<br/>host 4life.test<br/>/api · /auth · /health<br/>(cloud-provider-kind)"]
            GWSVC["Service gateway<br/>ClusterIP :8080"]
            subgraph GWDEP["Deployment gateway · 2 réplicas"]
                GW["API Gateway<br/>• valida JWT (HS256)<br/>• roteia /api/mobile e /api/web<br/>• esconde rotas internas /auth<br/>• sanitiza caminho (..)<br/>• rate limiting 📐"]
            end
        end

        %% ------------------------------------------------------------ BFFs
        subgraph BFFS["Camada BFF (sem banco)"]
            BMSVC["Service bff-mobile<br/>ClusterIP :4001"]
            BWSVC["Service bff-web<br/>ClusterIP :4002"]
            subgraph BMDEP["Deployment bff-mobile · HPA 2→5 réplicas (CPU)"]
                BM["bff-mobile<br/>• GET /inicio (agrega 3 serviços)<br/>• cards compactos<br/>• degrada com null + aviso"]
            end
            subgraph BWDEP["Deployment bff-web · 2 réplicas"]
                BW["bff-web<br/>• POST /auth/login<br/>• GET /painel, /comunidades/{id}<br/>• valida admin antes de criar mobilização"]
            end
        end

        %% ------------------------------------------------------------ DOMÍNIO
        subgraph DOM["Serviços de domínio (database per service)"]

            subgraph DOA["doadores-service · Deployment 2 réplicas · Service :3001"]
                DOA_R["Rotas REST<br/>/doadores, /auth/verificar"]
                DOA_S["Hash de senha<br/>(scrypt)"]
            end

            subgraph COM["comunidades-service · Deployment 2 réplicas · Service :3002"]
                COM_R["Rotas REST<br/>/comunidades, /membros"]
                COM_W["Modelo de ESCRITA<br/>(normalizado)"]
                COM_C["Consumidor idempotente<br/>ack manual + eventos_processados"]
                COM_P["Projeção do painel<br/>(atualizada por eventos) 📐"]
                COM_Q["Modelo de LEITURA CQRS<br/>ConsultaPainel 📐"]
                COM_SP["Participante SAGA<br/>T2 reservar-data / C2 📐"]
            end

            subgraph MOB["mobilizacoes-service · Deployment 1→3 réplicas (demo de escala) · Service :3003"]
                MOB_R["Rotas REST<br/>/mobilizacoes, /interesses<br/>(vagas com SELECT … FOR UPDATE)"]
                ORQ["🎯 ORQUESTRADOR DA SAGA<br/>OrquestradorSaga + EstadoSaga<br/>T1 cria PENDENTE · T4 confirma<br/>compensações C1→C3 em ordem reversa 📐"]
                MOB_PUB["Publicador de eventos<br/>(publica após commit; fallback na outbox)"]
                OUTBOX[("tabela outbox")]
                RELAY["Outbox relay<br/>FOR UPDATE SKIP LOCKED<br/>+ publisher confirm 📐"]
            end

            subgraph INF["informacoes-service · Deployment 2 réplicas · Service :3004"]
                INF_R["Rotas REST<br/>/conteudos, /dicas, /faq, /hemocentros"]
                INF_SP["Participante SAGA<br/>T3 reservar-janela (pivô) / C3 📐"]
            end
        end

        %% ------------------------------------------------------------ MENSAGERIA
        subgraph BUS["Mensageria · StatefulSet rabbitmq + PVC 1Gi · Service :5672 + headless"]
            EX{{"Exchange topic<br/>4life.events"}}
            Q1[["fila comunidades.mobilizacao-criada"]]
            Q2[["filas saga.comunidades.reservar-data<br/>saga.informacoes.reservar-janela<br/>+ filas de resposta 📐"]]
        end

        %% ------------------------------------------------------------ DADOS
        subgraph DATA["Dados · cada banco é um StatefulSet postgres:16 + PVC 1Gi + Service ClusterIP e headless"]
            DOA_DB[("doadores-db")]
            COM_DB[("comunidades-db<br/>+ eventos_processados<br/>+ reservas_calendario 📐")]
            MOB_DB[("mobilizacoes-db<br/>+ estado da saga 📐")]
            INF_DB[("informacoes-db<br/>+ reservas_hemocentro 📐")]
        end

        %% ------------------------------------------------------------ CONFIG
        subgraph CFG["Configuração"]
            CM["ConfigMaps<br/>um por componente:<br/>URLs, portas, LOG_LEVEL"]
            SEC["Secrets<br/>*-db-credentials · rabbitmq-credentials<br/>gateway-jwt"]
        end
    end

    %% ================================================================ FLUXO SÍNCRONO
    APP -->|HTTPS| ING
    WEB -->|HTTPS| ING
    ING --> GWSVC --> GW
    GW -->|/api/mobile/*| BMSVC --> BM
    GW -->|/api/web/* · /auth/login| BWSVC --> BW

    BM -->|HTTP| DOA_R
    BM -->|HTTP| COM_R
    BM -->|HTTP| MOB_R
    BM -->|HTTP| INF_R
    BW -->|HTTP| DOA_R
    BW -->|HTTP| COM_R
    BW -->|HTTP| MOB_R
    BW -->|HTTP| INF_R

    BW -.->|leitura do painel 📐| COM_Q

    %% ================================================================ INTERNO DOS SERVIÇOS
    DOA_R --> DOA_S
    COM_R --> COM_W
    MOB_R -->|cria mobilização| ORQ
    MOB_R --> MOB_PUB
    ORQ -->|grava comandos| OUTBOX
    MOB_PUB -->|fallback| OUTBOX
    OUTBOX --> RELAY
    COM_P --> COM_Q

    %% ================================================================ BANCOS
    DOA_S ==> DOA_DB
    DOA_R ==> DOA_DB
    COM_W ==> COM_DB
    COM_C ==> COM_DB
    COM_Q ==> COM_DB
    COM_SP ==> COM_DB
    MOB_R ==> MOB_DB
    ORQ ==> MOB_DB
    OUTBOX === MOB_DB
    INF_R ==> INF_DB
    INF_SP ==> INF_DB

    %% ================================================================ ASSÍNCRONO
    MOB_PUB -.->|mobilizacao.criada| EX
    RELAY -.->|eventos e comandos| EX
    EX -.->|binding mobilizacao.criada| Q1
    Q1 -.->|consome| COM_C
    COM_C -.->|atualiza| COM_P
    EX -.->|comandos da saga| Q2
    Q2 -.->|reservar-data| COM_SP
    Q2 -.->|reservar-janela| INF_SP
    COM_SP -.->|data-reservada / falha| ORQ
    INF_SP -.->|janela-reservada / falha| ORQ

    %% ================================================================ CONFIG
    CM -.- GWDEP
    CM -.- BMDEP
    CM -.- BWDEP
    CM -.- DOM
    SEC -.- GWDEP
    SEC -.- DOM
    SEC -.- DATA
    SEC -.- BUS

    %% ================================================================ ESTILOS
    classDef impl fill:#e6f4ea,stroke:#2e7d32,color:#1b1b1b
    classDef alvo fill:#fff8e1,stroke:#f9a825,stroke-dasharray:5 4,color:#1b1b1b
    classDef infra fill:#eceff1,stroke:#546e7a,color:#1b1b1b
    classDef orq fill:#fff3cd,stroke:#d84315,stroke-width:3px,stroke-dasharray:5 4,color:#1b1b1b

    class APP,WEB,GW,BM,BW,DOA_R,DOA_S,COM_R,COM_W,COM_C,MOB_R,MOB_PUB,OUTBOX,INF_R,EX,Q1,DOA_DB,COM_DB,MOB_DB,INF_DB impl
    class COM_P,COM_Q,COM_SP,RELAY,INF_SP,Q2 alvo
    class ORQ orq
    class ING,GWSVC,BMSVC,BWSVC,CM,SEC infra
```

## Componentes, um a um

| # | Componente | Onde roda | Responsabilidade | Estado |
|---|---|---|---|---|
| 1 | Ingress `4life` | cloud-provider-kind, host `4life.test` | Única entrada HTTP do cluster; só encaminha `/api`, `/auth` e `/health` ao gateway | ✅ |
| 2 | API Gateway | Deployment `gateway` (2 réplicas) | JWT, roteamento por prefixo, esconde `/auth` interno, sanitização | ✅ (rate limiting 📐) |
| 3 | bff-mobile | Deployment + **HPA 2→5** | Agrega dados para telas curtas do app | ✅ |
| 4 | bff-web | Deployment (2 réplicas) | Login, painéis e administração de comunidades | ✅ |
| 5 | doadores-service | Deployment (2) + `doadores-db` | Cadastro, perfil e verificação de credenciais | ✅ |
| 6 | comunidades-service | Deployment (2) + `comunidades-db` | Comunidades, membros, consumidor de `mobilizacao.criada` | ✅ |
| 7 | Consumidor idempotente | dentro de comunidades | `ack` manual + tabela `eventos_processados` | ✅ |
| 8 | Modelo de leitura CQRS | dentro de comunidades | Projeção desnormalizada do painel (defasagem ≤ 5 s) | 📐 |
| 9 | mobilizacoes-service | Deployment (1 → 3 na demo) + `mobilizacoes-db` | Mobilizações, interesses e controle de vagas | ✅ |
| 10 | **Orquestrador da SAGA** | dentro de mobilizacoes | Conduz T1→T4, persiste o estado e dispara C1→C3 em ordem reversa | 📐 (contratos em `src/saga/contratos.ts`) |
| 11 | Tabela outbox | `mobilizacoes-db` | Evento/comando gravado junto da mudança de domínio | ✅ (hoje só como fallback) |
| 12 | Outbox relay | dentro de mobilizacoes | Publica pendências com `SKIP LOCKED` + publisher confirm | 📐 (`src/outbox/relay.ts`) |
| 13 | Participante SAGA — comunidades | dentro de comunidades | T2 reservar data / C2 remover reserva | 📐 |
| 14 | informacoes-service | Deployment (2) + `informacoes-db` | Conteúdos, dicas, FAQ e hemocentros | ✅ |
| 15 | Participante SAGA — informacoes | dentro de informacoes | T3 reservar janela no hemocentro (pivô) / C3 | 📐 |
| 16 | RabbitMQ | StatefulSet + PVC | Exchange topic `4life.events`, filas de eventos e da saga | ✅ |
| 17 | 4 PostgreSQL | StatefulSets + PVC 1Gi cada | Um banco por serviço, sem acesso cruzado | ✅ |
| 18 | ConfigMaps | um por componente | URLs dos serviços, portas, `LOG_LEVEL` | ✅ |
| 19 | Secrets | `*-db-credentials`, `rabbitmq-credentials`, `gateway-jwt` | Senhas e chave do JWT, nunca no Git | ✅ |
| 20 | NetworkPolicies | namespace `4life` | default-deny; cada camada só aceita a camada de cima; banco só aceita o próprio serviço | ✅ |

## Isolamento (vale para Compose e Kubernetes)

- Gateway → só BFFs. BFFs → só serviços. Serviço → só o **próprio** banco e o RabbitMQ (se usar eventos).
- No **Docker Compose** isso é feito com as redes `edge`, `app`, `bus` e `data-<serviço>` (todas `internal`,
  exceto `edge`). No **Kubernetes**, com `NetworkPolicy` + `default-deny-ingress`.
- O `mobilizacoes-service` começa com 1 réplica de propósito, para a demonstração `1 → 3`
  (`scripts/demo-escala.sh`). Como o orquestrador persiste o estado da saga e o relay usa `SKIP LOCKED`,
  várias réplicas podem rodar sem duplicar trabalho.

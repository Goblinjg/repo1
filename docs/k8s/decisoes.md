# Decisões de containerização e orquestração (Parte 3)

## 1. Imagens e multi-stage

Todos os 7 componentes próprios usam o **mesmo padrão de Dockerfile**:

| Estágio | Base | Conteúdo |
|---|---|---|
| `build` | `node:22-alpine` | `npm ci` (com devDependencies), `tsc`, `npm prune --omit=dev` |
| `runtime` | `node:22-alpine` | só `dist/` (JS compilado), `node_modules` de produção, `migrations/` |

Práticas aplicadas:
- **Cache de camadas:** `package*.json` é copiado antes de `src/`, então o
  `npm ci` só roda de novo quando as dependências mudam.
- **Runtime mínimo:** `npm`, `npx`, `corepack` e `yarn` são removidos, porque
  não são usados em execução e só aumentam a superfície de ataque.
- **Usuário não-root:** `USER node` (uid 1000). Os arquivos da aplicação
  pertencem ao root e o processo não consegue alterá-los
  (`touch /app/x` → *Permission denied*).
- **HEALTHCHECK** com `wget` (busybox) em `/health`.
- **`.dockerignore`** exclui `node_modules`, `dist`, `.env*` e documentação.
  Isso deixa o contexto de build pequeno e impede que segredos entrem na
  imagem.

### Ganho medido

Comparamos com `docker/Dockerfile.single-stage`, a versão "ingênua": base
`node:22` completa (Debian), devDependencies, código TypeScript e cache do npm
na imagem final. A medição foi feita com `./scripts/medir-imagens.sh`.

No Docker 29 (containerd image store), `docker images` mostra duas colunas:
**CONTENT SIZE** (camadas comprimidas, ou seja, o que é baixado) e
**DISK USAGE** (o que ocupa em disco, já descompactado).

| Imagem | CONTENT SIZE (antes → depois) | DISK USAGE (antes → depois) |
|---|---|---|
| doadores-service | 433 MB → 62 MB (**-85%**) | 1,72 GB → 255 MB (**-85%**) |
| comunidades-service | 434 MB → 62 MB (**-85%**) | 1,72 GB → 256 MB (**-85%**) |
| mobilizacoes-service | 434 MB → 62 MB (**-85%**) | 1,72 GB → 256 MB (**-85%**) |
| informacoes-service | 433 MB → 62 MB (**-85%**) | 1,72 GB → 255 MB (**-85%**) |
| bff-mobile | 433 MB → 62 MB (**-85%**) | 1,71 GB → 254 MB (**-85%**) |
| bff-web | 433 MB → 62 MB (**-85%**) | 1,71 GB → 254 MB (**-85%**) |
| gateway | 434 MB → 63 MB (**-85%**) | 1,72 GB → 259 MB (**-84%**) |

De onde vem o ganho:
1. **Base alpine em vez de Debian.** Essa é a maior parte.
2. **Sem TypeScript nem @types.** Os ~23 MB do compilador ficam no estágio de
   build.
3. **Sem npm e sem cache do npm** na imagem final.

A economia vale para cada réplica em cada nó: menos tempo de *pull* no
`kind load` e no *rollout*, e menos pacotes para ter CVEs.

## 2. Redes no docker compose

```text
 host:8080 ─▶ [gateway]                                         rede edge
                 │
            [bff-mobile]  [bff-web]                             redes edge + app
                 │            │
   [doadores] [comunidades] [mobilizacoes] [informacoes]        rede app
       │         │      └──────┬──────┘         │
       │         │         [rabbitmq]           │               rede bus
       │         │                              │
 [doadores-db] [comunidades-db] [mobilizacoes-db] [informacoes-db]
  data-doadores data-comunidades data-mobilizacoes data-informacoes   (1 rede por banco)
```

| Rede | Membros | `internal` |
|---|---|---|
| `edge` | gateway, bff-mobile, bff-web | não (a porta do gateway é publicada) |
| `app` | BFFs + 4 serviços | **sim** |
| `bus` | comunidades, mobilizacoes, rabbitmq | **sim** |
| `data-<servico>` (x4) | o serviço + o seu banco | **sim** |
| `ops` | rabbitmq (painel em `127.0.0.1:15672`) | não |

- `internal: true` impede tráfego de saída para a internet. Um serviço
  comprometido não consegue exfiltrar dados.
- **Prova:** `./scripts/teste-isolamento.sh` testa 10 conexões TCP de dentro
  dos containers. As 4 permitidas conectam. As 6 proibidas falham, inclusive
  `doadores-service → IP do comunidades-db`, que retorna `ENETUNREACH`: nem
  sabendo o IP existe rota.

## 3. Volumes

- **Volumes nomeados** `4life_<servico>-db-data` guardam os bancos, e
  `4life_rabbitmq-data` guarda as filas duráveis.
- **Prova:** `./scripts/teste-persistencia.sh`.
  1. Cadastra um doador.
  2. Roda `docker compose down`, que destrói containers e redes.
  3. Roda `up` de novo.
  4. Faz login com o mesmo doador.
  Só `docker compose down -v` apaga os dados.
- O RabbitMQ usa `hostname: rabbitmq` fixo, porque ele guarda os dados por nome
  de nó. Com hostname aleatório, um container novo não reaproveitaria o volume.

## 4. Ordem de subida (`depends_on`)

```
bancos + rabbitmq (healthy) → serviços (healthy) → BFFs (healthy) → gateway
```

Sempre com `condition: service_healthy`, e os healthchecks são reais:
- bancos: `pg_isready`;
- RabbitMQ: `rabbitmq-diagnostics check_port_connectivity`;
- nossas imagens: `/health`.

Mesmo assim, os serviços **não dependem** dessa ordem: migrations e conexão
com o broker usam retentativas com backoff. Isso é essencial no Kubernetes, que
não tem `depends_on`.

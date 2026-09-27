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

---

# Kubernetes

## 5. Ferramenta e topologia

- **kind** com 3 nós (1 control-plane + 2 workers, arquivo
  `k8s/kind-config.yaml`). Com dois workers dá para ver as réplicas espalhadas
  (`topologySpreadConstraints`) e o reagendamento quando um pod morre.
- **Ingress:** cloud-provider-kind. Os motivos estão em
  [ingress-vs-gateway.md](ingress-vs-gateway.md).
- **Imagens:** carregadas nos nós com `kind load docker-image` e
  `imagePullPolicy: IfNotPresent`, sem registry.
- **Manifests:** organizados por componente em `k8s/<componente>/`, cada um com
  seu `kustomization.yaml`. `kubectl apply -k k8s/` aplica tudo no namespace
  `4life`.

## 6. Réplicas

| Componente | Réplicas | Justificativa |
|---|---|---|
| gateway | 2 | ponto único de entrada: sem réplica, qualquer restart derruba tudo |
| bff-mobile | 2 (HPA 2–5) | sem estado; recebe o maior volume (app); autoescala por CPU |
| bff-web | 2 | sem estado; alta disponibilidade |
| doadores, comunidades, informacoes | 2 | sem estado (o estado está no banco); tolera a perda de um nó |
| mobilizacoes-service | **1** | começa com 1 **de propósito**, para a demonstração `1 → 3` (`scripts/demo-escala.sh`) |
| bancos (x4), rabbitmq | 1 (StatefulSet) | PostgreSQL/RabbitMQ com várias réplicas exigem replicação própria (primário/réplica, quorum queues), o que está fora do escopo |

- `RollingUpdate` com `maxUnavailable: 0, maxSurge: 1`: uma atualização nunca
  reduz a capacidade.
- Os serviços **podem** ter várias réplicas porque as migrations usam
  `pg_advisory_lock`: só uma réplica aplica e as outras esperam.
- **Trade-off do HPA:** o Deployment do bff-mobile declara `replicas: 2`, como o
  enunciado pede. Se o HPA escalou para 4, um novo `kubectl apply` volta para 2
  até o HPA reagir. Em produção, o campo `replicas` seria removido dos
  Deployments geridos por HPA.

## 7. Probes

| Probe | Endpoint | Configuração | Efeito ao falhar |
|---|---|---|---|
| **startup** | `/health` | 2s × 30 (até 60s) | protege o boot: liveness e readiness só começam depois dela |
| **liveness** | `/health` | 10s, 3 falhas | o kubelet **reinicia** o container (processo travado) |
| **readiness** | `/ready` | 5s, 2 falhas | o pod **sai dos endpoints** do Service, sem reiniciar |

- `/health` **não depende de nada externo**. Se dependesse do banco, uma queda
  do PostgreSQL faria o kubelet reiniciar todos os pods em loop, sem resolver
  nada.
- `/ready` checa o **banco** e as **migrations**.
- BFFs e gateway não têm estado, então o `/ready` deles responde assim que o
  processo sobe. Checar dependências ali causaria falhas em cascata: um serviço
  fora do ar tiraria do balanceamento o BFF inteiro, inclusive as telas que não
  dependem dele.
- Bancos usam `pg_isready`. O RabbitMQ usa `rabbitmq-diagnostics`.
- **Demonstração:** `./scripts/k8s-demo-readiness.sh` derruba o banco do
  doadores. Os pods ficam `READY=false` com `RESTARTS=0`, o Service fica sem
  endpoints e o BFF responde 503. Quando o banco volta, tudo se recupera
  sozinho.

**Achado durante os testes (keep-alive × readiness).** A readiness remove o pod
só para **conexões novas**. O BFF reutiliza conexões keep-alive (o Fastify
oferece 72s), e por isso continuava mandando requisições ao pod "não pronto".
Correção: o serviço responde com `Connection: close` enquanto não está pronto
(hook `onSend` em `src/app.ts`), e a requisição seguinte volta a passar pelo
Service. O mesmo princípio explica a demo de escala: o `/whoami` do BFF usa
`agent: false` (conexão nova por chamada) e o script espera ~5s após o rollout
para o kube-proxy de todos os nós aprender os novos endpoints. Sem essa pausa,
medimos 49%/45%/6%; com ela, ~33% para cada pod.

## 8. Services, StatefulSets e volumes

- **Services ClusterIP** para gateway, BFFs e serviços. O DNS interno
  (`doadores-service:3001`) é o mesmo nome usado no compose, então a
  configuração dos BFFs é idêntica nos dois ambientes.
- **Bancos e RabbitMQ:** StatefulSet + Service **headless**
  (`clusterIP: None`). O nome `doadores-db` resolve direto para o pod
  `doadores-db-0`, que tem identidade estável.
- **Volumes:** `volumeClaimTemplates` cria um PVC por réplica
  (`dados-doadores-db-0`, 1 Gi, StorageClass `standard` do kind). Se o pod
  morre, o StatefulSet o recria **com o mesmo nome e o mesmo PVC**.
  Demonstração: `./scripts/k8s-teste-persistencia.sh`.
- O PGDATA fica num subdiretório (`/var/lib/postgresql/data/pgdata`), porque
  alguns provisionadores criam `lost+found` na raiz do volume e o `initdb`
  recusa diretório não vazio.

## 9. Isolamento de rede (NetworkPolicy)

É o equivalente das redes do compose:
- `default-deny-ingress` nega todo tráfego de entrada no namespace;
- cada pasta libera apenas quem pode chamar cada componente.

| Destino | Quem pode entrar |
|---|---|
| gateway | qualquer origem (vem do Ingress), porta http |
| bff-mobile / bff-web | pods do gateway |
| `<x>-service` | pods com `component: bff` |
| `<x>-db` | **somente** o `<x>-service` |
| rabbitmq | comunidades-service e mobilizacoes-service |

O kindnet (CNI padrão do kind) **aplica** NetworkPolicies.
`./scripts/k8s-teste-isolamento.sh` mostra que as 4 conexões permitidas
funcionam e que as 5 proibidas dão timeout, por exemplo doadores-service →
comunidades-db.

## 10. ConfigMaps e Secrets

- **ConfigMap por componente** (`<componente>-config`) com o que **não** é
  sensível: porta, hosts, nomes de banco, URLs dos serviços, timeouts e
  parâmetros do JWT. Os pods usam `envFrom`.
- **Secrets:** senhas dos bancos, credenciais do RabbitMQ e `JWT_SECRET`,
  injetados com `secretKeyRef`.
  - **Nunca** são versionados.
  - `k8s/secret.example.yaml` mostra só a estrutura.
  - `scripts/k8s-create-secrets.sh` lê o `.env` (que está no `.gitignore`) e cria
    os Secrets de forma idempotente.
- **Downward API:** `POD_NAME` vem de `metadata.name` e é usado pelo `/whoami`.
- O código **falha no boot** se faltar variável obrigatória (`obrigatoria()` em
  `src/config.ts`), e o gateway recusa `JWT_SECRET` com menos de 32 caracteres.
- **Endurecimento dos pods:**
  - `runAsNonRoot`, `readOnlyRootFilesystem` e `allowPrivilegeEscalation: false`;
  - todas as capabilities removidas e `seccompProfile: RuntimeDefault`.

## 11. Recursos (requests/limits)

| Componente | requests | limits |
|---|---|---|
| gateway, BFFs, serviços | 50m CPU / 96 Mi | 500m CPU / 256 Mi |
| PostgreSQL | 50m / 128 Mi | 1 CPU / 512 Mi |
| RabbitMQ | 100m / 256 Mi | 1 CPU / 512 Mi |

Os valores foram medidos com `kubectl top pods`: Node em repouso usa ~1m CPU e
~25 Mi. O request baixo permite que tudo caiba no kind de um notebook. O limit
de memória evita que um vazamento derrube o nó. O request de CPU é a base do
cálculo do HPA (70% de 50m).

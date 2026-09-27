# Roteiro do vídeo — Parte 3 (Containerização e Orquestração)

**Duração-alvo:** 9 min 30 s (limite de 10 min), em 4 blocos de ~2 min 15 s
mais abertura e encerramento.

## Preparação (antes de gravar, fora do vídeo)

```bash
./scripts/gerar-env.sh                 # se ainda não existir .env
docker compose down -v                 # compose limpo para a Thaís subir ao vivo
docker compose build                   # deixa as imagens em cache (o build ao vivo seria lento)
./scripts/medir-imagens.sh > /dev/null # cria as imagens :single-stage para o Kennedy comparar
./scripts/k8s-up.sh                    # cluster pronto para Tobias e João (~2 min)
IP=$(kubectl -n 4life get ingress 4life -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "$IP 4life.test" | sudo tee -a /etc/hosts   # permite usar curl http://4life.test direto
```

Dicas de gravação:
- Terminal com fonte grande (≥ 16 pt), tema claro e janela em tela cheia.
- Deixe um `alias k='kubectl -n 4life'` definido. Os comandos abaixo usam a
  forma completa, para ficar claro na tela.
- Cada integrante grava o próprio bloco. A edição junta os quatro.

---

## Abertura — João (15 s)

> "Somos a Nibble, e este é o 4Life, uma plataforma social para doadores de
> sangue. Na Parte 3 containerizamos os 7 componentes, subimos tudo com Docker
> Compose e orquestramos no Kubernetes. Cada um de nós vai mostrar uma parte."

**Na tela:** o README, rolando até o diagrama de arquitetura.

---

## Bloco 1 — Kennedy: Dockerfiles e multi-stage (≈ 2 min 15 s)

| # | Comando | O que mostrar / falar |
|---|---|---|
| 1 | `ls services/ bff/ gateway/` | "São 7 imagens próprias: 4 serviços, 2 BFFs e o gateway, cada um com seu Dockerfile." |
| 2 | `cat services/mobilizacoes-service/Dockerfile` | Percorrer os **2 estágios**:<br>• `build`: `npm ci` com devDependencies e `tsc`;<br>• `runtime`: copia só `dist/` e `node_modules` de produção.<br>Destacar `USER node`, `HEALTHCHECK`, a remoção do npm e a ordem dos `COPY` para aproveitar o cache. |
| 3 | `cat services/mobilizacoes-service/.dockerignore` | "O `.dockerignore` impede que `node_modules` local e o `.env` entrem no contexto de build." |
| 4 | `cat docker/Dockerfile.single-stage` | "Para medir o ganho, fizemos uma versão ingênua: base `node:22` completa, sem multi-stage." |
| 5 | `docker images \| grep -E '^(IMAGE\|4life/mobilizacoes)'` | Comparar as colunas: **CONTENT SIZE 434 MB → 62 MB** e **DISK USAGE 1,72 GB → 256 MB**, **-85%**. |
| 6 | `sed -n '/Ganho medido/,/De onde vem/p' docs/k8s/decisoes.md` | Mostrar a tabela com as 7 imagens. "O ganho vem da base alpine, de não levar TypeScript e @types, e de tirar o npm da imagem final." |
| 7 | `docker run --rm --entrypoint id 4life/gateway:1.0.0` | Mostra `uid=1000(node)`: o container **não roda como root**. |

---

## Bloco 2 — Thaís: Compose, redes e volumes (≈ 2 min 15 s)

| # | Comando | O que mostrar / falar |
|---|---|---|
| 1 | `docker compose up -d` | "Um único comando sobe os 12 containers. O `depends_on` com `service_healthy` garante a ordem: bancos → serviços → BFFs → gateway." |
| 2 | `watch -n2 docker compose ps` (até todos ficarem healthy, ~30 s; depois Ctrl+C) | Todos `(healthy)`. Os healthchecks são reais: `pg_isready`, `rabbitmq-diagnostics` e o `/health` de cada serviço. |
| 3 | `sed -n '/^networks:/,$p' docker-compose.yml` | Redes `edge`, `app`, `bus` e uma `data-<servico>` por banco, todas `internal: true` (sem saída para a internet). Volumes nomeados no fim do arquivo. |
| 4 | `./scripts/teste-isolamento.sh` | **Momento-chave:** `doadores-service → comunidades-db` **FALHOU**. Até pelo IP dá `ENETUNREACH`. Já o acesso ao próprio banco conecta. |
| 5 | `./scripts/smoke-test.sh` | Mostra o sistema funcionando: cadastro, login JWT, comunidade, mobilização e o **evento pelo RabbitMQ** atualizando o contador. |
| 6 | `./scripts/teste-persistencia.sh` | Cadastra um doador, roda `docker compose down` (containers destruídos), sobe de novo e **o login funciona**: o dado ficou no volume `4life_doadores-db-data`. |
| 7 | `cat .env.example && git check-ignore -v .env` | "Credenciais só no `.env`, que está no `.gitignore`. Versionamos apenas o exemplo." |

---

## Bloco 3 — Tobias: Deployments, Services e Ingress (≈ 2 min 15 s)

| # | Comando | O que mostrar / falar |
|---|---|---|
| 1 | `kubectl get nodes` | Cluster kind com 3 nós: 1 control-plane e 2 workers. |
| 2 | `ls k8s/ && cat k8s/kustomization.yaml` | Manifests organizados por componente; `kubectl apply -k k8s/` aplica tudo. |
| 3 | `kubectl -n 4life get deploy,statefulset` | 7 Deployments com réplicas definidas e 5 StatefulSets (4 bancos e o RabbitMQ). |
| 4 | `kubectl -n 4life get pods -o wide` | 18 pods Ready. Mostrar a coluna **NODE**: as réplicas ficam espalhadas entre os workers. |
| 5 | `sed -n '/resources:/,/failureThreshold: 2/p' k8s/doadores/deployment.yaml` | requests/limits e as 3 probes: **startup** e **liveness** em `/health`, **readiness** em `/ready`, que checa o banco. |
| 6 | `kubectl -n 4life get svc` e `kubectl -n 4life get endpointslices -l kubernetes.io/service-name=doadores-service` | Services **ClusterIP** para comunicação interna. Os endpoints são os IPs dos pods Ready. |
| 7 | `kubectl -n 4life get pvc` | Um PVC por banco (`volumeClaimTemplates`). |
| 8 | `kubectl -n 4life get ingress && cat k8s/gateway/ingress.yaml` | Host `4life.test`; só `/api`, `/auth` e `/health` entram, e **sempre para o gateway**. |
| 9 | `curl http://4life.test/api/mobile/info/faq \| jq '.[0]'` e `curl -i http://4life.test/api/web/painel` | Pelo Ingress: rota pública responde 200; rota protegida responde **401** porque o **gateway** exige JWT. "O Ingress roteia; autenticação e roteamento por cliente continuam no gateway." (`docs/k8s/ingress-vs-gateway.md`) |
| 10 | `kubectl -n 4life delete pod -l app.kubernetes.io/name=gateway --wait=false && kubectl -n 4life get pods -l app.kubernetes.io/name=gateway -w` (Ctrl+C após os novos ficarem Ready) | Autocura: o Deployment recria os pods apagados. |

---

## Bloco 4 — João: ConfigMaps, Secrets e escalabilidade (≈ 2 min 15 s)

| # | Comando | O que mostrar / falar |
|---|---|---|
| 1 | `kubectl -n 4life get configmap mobilizacoes-service-config -o yaml \| sed -n '/^data/,/^kind/p'` | Configuração não sensível: host do banco, porta, broker. Entra no pod via `envFrom`. |
| 2 | `cat k8s/secret.example.yaml \| head -12` | Versionamos **só a estrutura**, sem valores reais. |
| 3 | `sed -n '/aplicar doadores/,$p' scripts/k8s-create-secrets.sh` | Os Secrets são criados a partir do `.env` com `kubectl create secret --dry-run=client \| kubectl apply`. |
| 4 | `kubectl -n 4life get secret gateway-jwt -o jsonpath='{.data.JWT_SECRET}' \| base64 -d \| cut -c1-12; echo` | **"Secret não é criptografia"**: qualquer pessoa com acesso de leitura decodifica com base64. A proteção real vem de RBAC e de criptografia em repouso no etcd. |
| 5 | `grep -n "secretKeyRef\|POD_NAME" -A1 k8s/mobilizacoes/deployment.yaml` | Senhas via `secretKeyRef`; nome do pod via **Downward API**, que é o que o `/whoami` usa. |
| 6 | `curl -s http://4life.test/api/mobile/diagnostico/whoami \| jq` | O retorno mostra o pod do BFF e o pod do mobilizacoes que atenderam. |
| 7 | `./scripts/demo-escala.sh` | **Momento-chave:**<br>• com 1 réplica, 100% das requisições vão para um pod;<br>• depois de `kubectl scale --replicas=3`, a distribuição fica em **~33% por pod**.<br>Explicar a espera de 5 s para o kube-proxy propagar os endpoints. |
| 8 | `kubectl -n 4life get hpa` e `kubectl -n 4life top pods \| head -5` | Opcional: HPA no bff-mobile (2 a 5 réplicas, 70% de CPU) e o metrics-server funcionando. |

---

## Encerramento — João (15 s)

> "Com isso, o 4Life roda do zero com um comando no compose e com um script no
> Kubernetes. As instruções estão no README. Na Parte 4 entram a SAGA, o CQRS e
> o componente de LLM, e a estrutura para eles já está no repositório."

**Na tela:** `kubectl -n 4life get pods`, com todos Running.

---

### Controle de tempo

| Bloco | Tempo | Acumulado |
|---|---|---|
| Abertura | 0:15 | 0:15 |
| Kennedy | 2:15 | 2:30 |
| Thaís | 2:15 | 4:45 |
| Tobias | 2:15 | 7:00 |
| João | 2:15 | 9:15 |
| Encerramento | 0:15 | 9:30 |

Se estourar, corte primeiro:
- Kennedy #3;
- Thaís #7;
- Tobias #10;
- João #8.

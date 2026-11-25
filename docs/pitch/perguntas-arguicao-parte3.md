# Perguntas prováveis da arguição — Parte 3

Respostas curtas, com referência ao que existe no nosso projeto.

### 1. Qual a diferença entre Service e Ingress?
- O **Service** dá um **endereço estável dentro do cluster** para um conjunto de
  pods que muda o tempo todo. Exemplo: `doadores-service:3001` → IP virtual
  (ClusterIP) → pods Ready, balanceado pelo kube-proxy. Atua na camada 4
  (TCP/UDP).
- O **Ingress** é uma regra de **entrada HTTP externa**: host `4life.test` +
  caminho `/api` → Service `gateway`. Atua na camada 7 e precisa de um
  controlador (o nosso é o cloud-provider-kind).
- Resumo: o Ingress **usa** Services como destino, e Services funcionam sem
  Ingress. Por isso só o gateway é alcançável de fora, e todo o resto é ClusterIP.

### 2. Por que Secret não é criptografia?
- Os valores de um Secret são só **base64**, que é uma codificação reversível.
  Qualquer pessoa com permissão de leitura faz `kubectl get secret -o jsonpath=…
  | base64 -d`. No vídeo mostramos isso com o `gateway-jwt`.
- Por padrão, o Secret fica **em texto no etcd**.
- O que o Secret oferece:
  - separa dado sensível da configuração comum;
  - tem permissões próprias (RBAC);
  - não aparece em `kubectl describe`;
  - pode ser montado só nos pods que precisam.
- A proteção real vem de:
  - **RBAC** restritivo;
  - **encryption at rest** no etcd (`EncryptionConfiguration`/KMS);
  - ferramentas como Sealed Secrets, SOPS ou Vault.
- No nosso projeto, os Secrets **nunca** vão para o Git: são gerados do `.env`
  por `scripts/k8s-create-secrets.sh`.

### 3. O que acontece com o dado se o pod do banco morrer?
- **Nada se perde.** O PostgreSQL grava em um **PersistentVolume** ligado ao PVC
  `dados-doadores-db-0`, criado pelo `volumeClaimTemplates` do StatefulSet.
- O pod é descartável; o volume não.
- O StatefulSet recria o pod **com o mesmo nome** (`doadores-db-0`), e ele monta
  **o mesmo PVC**.
- Durante a queda, a readiness do doadores-service falha e os pods saem do
  Service (503 em vez de erro 500), e voltam sozinhos.
- Demonstração: `./scripts/k8s-teste-persistencia.sh` (cadastra, mata o pod,
  faz login com sucesso).
- O dado só se perde se o **PVC/PV** for apagado. O `./scripts/k8s-down.sh`
  apaga o cluster inteiro.

### 4. Liveness × readiness?

| | Pergunta que responde | Se falhar | Nosso endpoint |
|---|---|---|---|
| **Liveness** | "O processo está vivo/saudável?" | kubelet **reinicia** o container | `/health` (não depende de nada externo) |
| **Readiness** | "Pode receber tráfego agora?" | pod **sai dos endpoints** do Service, sem reiniciar | `/ready` (checa banco e migrations) |
| **Startup** | "Já terminou de subir?" | segura as outras duas até o boot acabar | `/health` |

- Se a liveness checasse o banco, uma queda do PostgreSQL faria o Kubernetes
  reiniciar todos os serviços em loop, sem resolver nada.
- Demonstração: `./scripts/k8s-demo-readiness.sh` (`READY=false`, `RESTARTS=0`,
  503 e depois recuperação).

### 5. O que o multi-stage trouxe e como mediram?
- O estágio `build` tem devDependencies e o compilador TypeScript.
- O estágio `runtime` leva só o JS compilado e as dependências de produção, sobre
  `node:22-alpine` e sem npm.
- Comparação com `docker/Dockerfile.single-stage` (`node:22` completo), medida
  com `docker images` via `scripts/medir-imagens.sh`:
  - CONTENT SIZE: **434 MB → 62 MB (-85%)**;
  - DISK USAGE: **1,72 GB → 256 MB**.
- Benefícios:
  - *pull* e *rollout* mais rápidos;
  - menos pacotes com CVEs;
  - o código-fonte e as ferramentas de build não vão para produção.

### 6. Como garantem que um serviço não acessa o banco de outro?
- **Compose:**
  - cada banco fica numa rede própria `data-<servico>` (`internal: true`), onde
    só está o seu serviço;
  - `./scripts/teste-isolamento.sh` mostra `doadores-service → comunidades-db`
    falhando, até pelo IP (`ENETUNREACH`).
- **Kubernetes:**
  - NetworkPolicy `default-deny-ingress` + regras explícitas (`<x>-db` só aceita
    o `<x>-service`);
  - o kindnet aplica essas regras, como mostra `./scripts/k8s-teste-isolamento.sh`.
- Além disso, cada banco tem **usuário e senha próprios**. Mesmo alcançando o
  host, o serviço não teria a credencial.

### 7. Por que StatefulSet para o banco e não Deployment?
O StatefulSet dá três coisas:
1. **Identidade estável:** o pod sempre se chama `doadores-db-0`.
2. **Um PVC por réplica**, via `volumeClaimTemplates`, que acompanha aquela
   identidade.
3. **Ordem** de criação e remoção.

Um Deployment trata os pods como intercambiáveis e compartilharia o mesmo PVC
entre réplicas, o que não serve para bancos.

Usamos dois Services por banco:
- **headless** (`doadores-db-headless`), exigido pelo StatefulSet;
- **ClusterIP** (`doadores-db`), usado pelos clientes. Com só o headless, vimos
  `ENOTFOUND` por alguns segundos depois do banco reiniciar, por causa do cache
  negativo do CoreDNS.

### 8. Se já existe Ingress, por que manter o API Gateway?
- O Ingress só entende **host e caminho**: decide o que entra e para qual Service
  vai.
- O gateway tem **regras de aplicação**:
  - emitir e validar o JWT;
  - separar rotas públicas de protegidas;
  - remover `x-user-*` forjados e injetar a identidade;
  - bloquear rotas internas dos BFFs;
  - rotear `/api/mobile` × `/api/web` para o BFF certo.
- Manter isso no código deixa o comportamento **igual no compose**, que não tem
  Ingress, e evita dependência de anotações de um controlador específico.
- Detalhes: `docs/k8s/ingress-vs-gateway.md`.

### 9. Como as requisições se distribuem quando escalam para 3 réplicas?
- `kubectl scale` cria os pods. Cada um só entra nos **endpoints** do Service
  depois de passar na readiness.
- O kube-proxy de cada nó programa regras que escolhem um endpoint
  aleatoriamente **por conexão nova**. Resultado: ~33% por pod
  (`./scripts/demo-escala.sh`).
- Dois cuidados que aprendemos testando:
  - o BFF chama o `/whoami` **sem keep-alive**. Com keep-alive, a conexão
    reaproveitada ficaria presa a um único pod;
  - o script espera ~5 s depois do rollout para os endpoints chegarem a todos os
    nós. Sem isso, medimos 49%/45%/6%.

### 10. No Kubernetes não existe `depends_on`. Como o sistema sobe na ordem certa?
Ele **não precisa** subir em ordem:
- os serviços sobem, respondem `/health` e ficam **não prontos** até conseguirem
  aplicar as migrations. Há retentativa com backoff, e a conexão com o RabbitMQ
  também é refeita sozinha;
- a readiness impede que recebam tráfego antes disso;
- com várias réplicas, só uma aplica as migrations, graças a
  `pg_advisory_lock`. As outras esperam.

Esse desenho **tolerante a falhas** também cobre quedas em produção, não só o
boot.

---

### Extras (se sobrar tempo)

**ConfigMap × Secret?** Ambos viram variáveis de ambiente ou arquivos. O
ConfigMap guarda o que não é sensível (hosts, portas, URLs). O Secret guarda
senhas e o `JWT_SECRET`, tem RBAC próprio e não é versionado.

**Por que o container não roda como root?** Se a aplicação for comprometida, o
atacante fica com um usuário sem privilégios, num sistema de arquivos somente
leitura (`readOnlyRootFilesystem`), sem capabilities e sem escalada de
privilégio.

**O que o HPA faz?** Ajusta as réplicas do bff-mobile (2 a 5) para manter a CPU
média em 70% do *request*, com base nas métricas do metrics-server. Ele fica
separado do mobilizacoes-service para não conflitar com o `kubectl scale` da
demonstração.

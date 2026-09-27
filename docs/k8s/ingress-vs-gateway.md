# Ingress × API Gateway

Na Parte 2 definimos um **API Gateway** próprio (gateway routing). Na Parte 3
entrou o **Ingress** do Kubernetes. Os dois recebem tráfego HTTP de fora, mas
atuam em **camadas diferentes** e não se substituem.

```text
 cliente ──HTTP──▶ Ingress (cloud-provider-kind / Envoy)  ──▶ Service gateway ──▶ pods gateway ──▶ BFFs ──▶ serviços
                   camada de INFRAESTRUTURA do cluster           camada de APLICAÇÃO (código nosso)
                   "qual host/caminho entra e para qual Service"  "quem é o usuário e qual backend atende"
```

## O que o Ingress faz

Arquivo: [`k8s/gateway/ingress.yaml`](../../k8s/gateway/ingress.yaml)

| Responsabilidade | Como está configurado |
|---|---|
| Ser o **ponto de entrada externo** do cluster | IP de LoadBalancer atribuído pelo cloud-provider-kind |
| **Roteamento por host** | só aceita `Host: 4life.test`; qualquer outro host retorna 404 |
| **Roteamento por caminho (grosso)** | só `/api`, `/auth` e `/health` passam; o resto retorna 404 na borda, sem chegar aos pods |
| **Balancear entre os pods** do gateway | encaminha para o Service `gateway` (2 réplicas) |
| TLS (em produção) | seria o lugar de terminar HTTPS (`spec.tls` + cert-manager). No kind local usamos HTTP |

O Ingress **não entende a aplicação**. Ele não sabe o que é um JWT, um usuário
ou um BFF, e trabalha só com host, caminho e Service.

## O que continua no gateway (e por quê)

Arquivos: [`gateway/src/`](../../gateway/src)

| Responsabilidade | Por que não foi para o Ingress |
|---|---|
| **Autenticação JWT** (`/auth/login` emite, o resto valida) | É regra de negócio e depende do segredo `JWT_SECRET`. O Ingress padrão não valida JWT, e fazer isso via anotações específicas prenderia o sistema a um controlador |
| **Rotas públicas × protegidas** | A lista é de domínio (cadastro e FAQ públicos, painel protegido) e muda junto com o produto |
| **Sanitizar e injetar identidade** (`x-user-id`) | Remover cabeçalhos forjados e propagar o usuário para BFFs e serviços é parte do contrato interno da aplicação |
| **Bloquear rotas internas dos BFFs** (`/api/*/auth/*` → 404) | Proteção ligada ao contrato dos BFFs |
| **Roteamento por cliente** (`/api/mobile` → bff-mobile, `/api/web` → bff-web, com remoção do prefixo) | É o padrão BFF da Parte 2. Mantê-lo no código deixa o comportamento **idêntico no compose e no K8s**, e o compose não tem Ingress |

## Por que não usar só um dos dois?

- **Só Ingress:** perderíamos o JWT e a lógica de identidade, ou ficaríamos
  presos a anotações de um controlador específico. Também teríamos
  comportamentos diferentes no compose e no K8s.
- **Só gateway, exposto via NodePort/LoadBalancer:** funciona, mas perde o que o
  Ingress dá de graça: virtual hosts, TLS centralizado e um ponto de entrada
  padronizado para vários sistemas no mesmo cluster.

**Resumo:** o Ingress decide *se* a requisição entra no cluster e *para qual
Service* ela vai. O gateway decide *quem* está pedindo e *qual backend* atende.

## Sobre o controlador escolhido

O kind recomenda o **cloud-provider-kind** (v0.9+), que implementa Ingress
nativamente: ele cria um Envoy fora do cluster com IP próprio na rede `kind`. O
**ingress-nginx**, que foi a escolha tradicional, foi aposentado pela comunidade
Kubernetes em 2026 e não recebe mais correções. Por isso não o usamos. Como o
manifesto é um `networking.k8s.io/v1 Ingress` padrão, sem anotações, ele
funciona igual com outros controladores (Traefik, Contour, HAProxy).

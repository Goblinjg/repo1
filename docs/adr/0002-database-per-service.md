# ADR-0002 — Um banco por serviço

**Status:** aceito

## Contexto
Os requisitos exigem que cada serviço de domínio mantenha seus dados em uma
instância de banco separada.

## Decisão
- Cada serviço de domínio tem **sua própria instância PostgreSQL**.
- As credenciais são exclusivas de cada serviço.
- Nenhum outro componente consegue alcançar esse banco pela rede:
  - no compose, via redes `data-<servico>`;
  - no Kubernetes, via NetworkPolicy.
- As migrations ficam dentro do serviço e rodam no boot, com `pg_advisory_lock`
  para que réplicas concorrentes não apliquem a mesma migration duas vezes.

## Consequências
- Não existem JOINs nem FKs entre domínios; as referências são feitas por id.
- Consistência entre serviços é eventual (eventos) e, na Parte 4, orquestrada via
  SAGA.

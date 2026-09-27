# ADR-0001 — Stack tecnológica

**Status:** aceito

## Contexto
A equipe tem 4 integrantes com experiência heterogênea. O projeto tem 7 componentes
próprios (4 serviços, 2 BFFs e o gateway), e todos precisam ser containerizados e
orquestrados.

## Decisão
- **Node.js 22 + TypeScript + Fastify** em todos os componentes próprios.
- **PostgreSQL 16** como banco de cada serviço.
- **RabbitMQ 3** como broker de mensagens.
- **JWT (HS256)** emitido e validado pelo gateway.

## Consequências
- Uma única linguagem reduz a curva de aprendizado e padroniza os Dockerfiles.
- Imagens `node:22-alpine` são enxutas (~50 MB de base).
- Não há biblioteca compartilhada entre serviços: o código de infraestrutura
  (`db.ts`, `broker.ts`, `config.ts`) é **duplicado de propósito**, para que os
  serviços sejam versionados e implantados de forma independente.

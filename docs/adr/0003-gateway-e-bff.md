# ADR-0003 — API Gateway + BFFs

**Status:** aceito

## Contexto
O sistema tem dois clientes (mobile e web), com necessidades diferentes de
agregação, e 4 serviços que não devem ser expostos diretamente.

## Decisão
- Um **API Gateway** próprio como ponto único de entrada. Ele cuida de:
  - autenticação JWT;
  - roteamento por prefixo (`/api/mobile`, `/api/web`, `/auth`);
  - sanitização dos cabeçalhos `x-user-*`.
- Um **BFF por cliente**, sem estado e sem banco, que agrega as chamadas aos
  serviços.
- O gateway só alcança os BFFs; os BFFs alcançam os serviços; os serviços
  alcançam apenas o próprio banco e o broker.

## Consequências
- Um hop a mais de latência (gateway → BFF → serviço).
- Os serviços de domínio ficam simples e agnósticos de cliente.
- O login passa pelo bff-web (`/auth/verificar-credenciais`), porque o gateway
  não tem acesso direto ao doadores-service.

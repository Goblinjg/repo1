# SAGA — estrutura reservada para a Parte 4

Fluxo previsto: **criar mobilização** como SAGA orquestrada.
1. `mobilizacoes`: cria a mobilização em estado `PENDENTE`;
2. `comunidades`: valida admin e reserva o slot no calendário da comunidade;
3. sucesso → `CONFIRMADA`; falha → compensação (`CANCELADA`).

Nesta parte existem apenas os contratos em `contratos.ts`.

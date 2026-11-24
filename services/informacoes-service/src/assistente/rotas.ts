import type { FastifyInstance } from 'fastify';
import type { criarAssistente } from './servico.js';

export async function rotasAssistente(app: FastifyInstance, { assistente }: { assistente: ReturnType<typeof criarAssistente> }) {
  app.post<{ Body: { pergunta: string; usarRag?: boolean; usarCache?: boolean } }>(
    '/assistente/perguntar',
    {
      schema: {
        body: {
          type: 'object',
          required: ['pergunta'],
          additionalProperties: false,
          properties: {
            pergunta: { type: 'string', minLength: 3, maxLength: 500 },
            // false = sem recuperação (linha de base da avaliação do RAG)
            usarRag: { type: 'boolean', default: true },
            usarCache: { type: 'boolean', default: true },
          },
        },
      },
    },
    async (req) => assistente.perguntar(req.body),
  );

  app.get('/assistente/status', async () => assistente.status());

  // operação: refaz a ingestão (ex.: depois de editar a base de conhecimento) e limpa o cache
  app.post('/assistente/ingestao', async () => assistente.reingerir());
  app.delete('/assistente/cache', async () => ({ removidas: await assistente.limparCache() }));
}

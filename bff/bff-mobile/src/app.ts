import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { ErroServico, ServicoIndisponivel } from './cliente.js';

export function criarApp(): FastifyInstance {
  const app = Fastify({ logger: { level: config.logLevel } });

  app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok', servico: config.servico, instancia: config.instancia }));
  // O BFF não tem estado nem banco: está pronto assim que o processo sobe.
  // Não checamos os serviços aqui para não propagar falhas em cascata (um serviço fora
  // tiraria o BFF inteiro do balanceamento, inclusive as telas que não dependem dele).
  app.get('/ready', { logLevel: 'warn' }, async () => ({ status: 'ready' }));

  app.setErrorHandler((erro: Error & { statusCode?: number }, req, reply) => {
    if (erro instanceof ErroServico) {
      if (erro.status < 500) return reply.code(erro.status).send(erro.corpo);
      req.log.error({ servico: erro.servico, status: erro.status }, 'erro no serviço');
      return reply.code(502).send({ erro: `${erro.servico} falhou` });
    }
    if (erro instanceof ServicoIndisponivel) {
      req.log.error({ servico: erro.servico, causa: String(erro.causa) }, 'serviço indisponível');
      return reply.code(503).send({ erro: erro.message });
    }
    if (erro.statusCode && erro.statusCode < 500) return reply.code(erro.statusCode).send({ erro: erro.message });
    req.log.error(erro);
    return reply.code(500).send({ erro: 'erro interno' });
  });

  return app;
}

export async function iniciar(app: FastifyInstance): Promise<void> {
  const encerrar = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', encerrar);
  process.on('SIGINT', encerrar);
  await app.listen({ host: '0.0.0.0', port: config.porta });
}

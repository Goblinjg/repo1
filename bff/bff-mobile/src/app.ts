// @ts-expect-error Fastify is provided by the application's runtime dependencies.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { config } from './config.js';
import { ErroServico, ServicoIndisponivel } from './cliente.js';

export function criarApp(): FastifyInstance {
  const app = Fastify({ logger: { level: config.logLevel } });

  app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok', servico: config.servico, instancia: config.instancia }));
  // Verifica se o BFF está disponível e responde à requisição de health check.
  // Como o BFF não mantém estado próprio, a verificação considera apenas o
  // funcionamento do próprio processo.
  app.get('/ready', { logLevel: 'warn' }, async () => ({ status: 'ready' }));

  app.setErrorHandler((erro: Error & { statusCode?: number }, req: FastifyRequest, reply: FastifyReply) => {
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
  const processo = (globalThis as typeof globalThis & {
    process: { on(evento: 'SIGTERM' | 'SIGINT', listener: () => void): void; exit(codigo: number): never };
  }).process;
  const encerrar = async () => {
    await app.close();
    processo.exit(0);
  };
  processo.on('SIGTERM', encerrar);
  processo.on('SIGINT', encerrar);
  await app.listen({ host: '0.0.0.0', port: config.porta });
}

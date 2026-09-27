import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { bancoRespondendo, estado, migrarComRetentativas, pool, pronto } from './db.js';

// Monta o servidor com health/readiness e tratamento de erros comuns do PostgreSQL.
// `informativos` entram na resposta do /ready, mas não afetam a prontidão (ex.: broker).
export function criarApp(informativos: () => Record<string, string> = () => ({})): FastifyInstance {
  const app = Fastify({ logger: { level: config.logLevel } });

  // liveness: só indica que o processo está vivo; não depende de nada externo
  app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok', servico: config.servico, instancia: config.instancia }));

  // readiness: só recebe tráfego quando o banco responde e as migrations foram aplicadas
  app.get('/ready', { logLevel: 'warn' }, async (_req, reply) => {
    const banco = await bancoRespondendo();
    estado.bancoOk = banco;
    const ok = banco && estado.migrado;
    reply.code(ok ? 200 : 503);
    return {
      status: ok ? 'ready' : 'not-ready',
      checks: { banco: banco ? 'ok' : 'falha', migrations: estado.migrado ? 'ok' : 'pendente', ...informativos() },
    };
  });

  // Readiness tira o pod do Service só para conexões NOVAS; clientes com keep-alive
  // (os BFFs) continuariam usando a conexão antiga. Fora de prontidão, pedimos para
  // fechar a conexão: a próxima requisição passa de novo pelo Service e vai para um pod pronto.
  app.addHook('onSend', async (_req, reply) => {
    if (!pronto()) reply.header('connection', 'close');
  });

  app.setErrorHandler((erro: Error & { code?: string; statusCode?: number }, req, reply) => {
    if (erro.code === '23505') return reply.code(409).send({ erro: 'registro já existe' });
    if (erro.statusCode && erro.statusCode < 500) return reply.code(erro.statusCode).send({ erro: erro.message });
    req.log.error(erro);
    return reply.code(500).send({ erro: 'erro interno' });
  });

  return app;
}

export async function iniciar(app: FastifyInstance): Promise<void> {
  const encerrar = async () => {
    app.log.info('encerrando');
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', encerrar);
  process.on('SIGINT', encerrar);

  await app.listen({ host: '0.0.0.0', port: config.porta });
  void migrarComRetentativas(app.log);
  const checar = async () => { estado.bancoOk = await bancoRespondendo(); };
  void checar();
  setInterval(checar, 5000).unref();
}

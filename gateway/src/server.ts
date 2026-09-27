import Fastify, { type FastifyRequest } from 'fastify';
import proxy from '@fastify/http-proxy';
import type { IncomingHttpHeaders } from 'node:http';
import { autenticar, emitirToken } from './auth.js';
import { config } from './config.js';

const app = Fastify({ logger: { level: config.logLevel }, requestIdHeader: 'x-request-id' });

app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok', servico: config.servico, instancia: config.instancia }));
// Gateway sem estado: pronto quando o processo sobe. Não checa os BFFs para não
// tirar o ponto de entrada inteiro do ar por causa de um único backend.
app.get('/ready', { logLevel: 'warn' }, async () => ({ status: 'ready' }));

// Login: o gateway não alcança o doadores-service (isolamento de rede), então a
// verificação passa pelo bff-web; quem assina o token é o gateway, o único que conhece o segredo.
app.post<{ Body: { email: string; senha: string } }>(
  '/auth/login',
  {
    schema: {
      body: { type: 'object', required: ['email', 'senha'], properties: { email: { type: 'string' }, senha: { type: 'string' } } },
    },
  },
  async (req, reply) => {
    let resposta: Response;
    try {
      resposta = await fetch(`${config.bffWeb}/auth/verificar-credenciais`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: req.body.email, senha: req.body.senha }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch {
      return reply.code(503).send({ erro: 'serviço de autenticação indisponível' });
    }
    if (resposta.status === 401) return reply.code(401).send({ erro: 'credenciais inválidas' });
    if (!resposta.ok) return reply.code(502).send({ erro: 'falha na autenticação' });
    const usuario = (await resposta.json()) as { id: string; nome: string };
    const token = await emitirToken(usuario);
    return { token, tipo: 'Bearer', expiraEm: config.jwt.expiraEmSegundos };
  },
);

// Remove cabeçalhos de identidade vindos do cliente (evita falsificação) e injeta os do token.
function cabecalhosInternos(req: FastifyRequest, headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const limpos: IncomingHttpHeaders = {};
  for (const [nome, valor] of Object.entries(headers)) {
    if (!nome.startsWith('x-user-') && nome !== 'authorization') limpos[nome] = valor;
  }
  limpos['x-request-id'] = req.id;
  if (req.usuario) {
    limpos['x-user-id'] = req.usuario.id;
    limpos['x-user-nome'] = encodeURIComponent(req.usuario.nome);
  }
  return limpos;
}

for (const [prefixo, upstream] of [
  ['/api/mobile', config.bffMobile],
  ['/api/web', config.bffWeb],
] as const) {
  await app.register(proxy, {
    upstream,
    prefix: prefixo,
    rewritePrefix: '',
    preHandler: autenticar,
    http: { requestOptions: { timeout: config.timeoutMs } },
    replyOptions: { rewriteRequestHeaders: (req, headers) => cabecalhosInternos(req as FastifyRequest, headers) },
  });
}

const encerrar = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);

await app.listen({ host: '0.0.0.0', port: config.porta });

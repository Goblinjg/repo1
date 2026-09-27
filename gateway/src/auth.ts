import { jwtVerify, SignJWT } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';

export interface Usuario {
  id: string;
  nome: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    usuario?: Usuario;
  }
}

export async function emitirToken(usuario: Usuario): Promise<string> {
  return new SignJWT({ nome: usuario.nome })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(usuario.id)
    .setIssuer(config.jwt.emissor)
    .setIssuedAt()
    .setExpirationTime(`${config.jwt.expiraEmSegundos}s`)
    .sign(config.jwt.segredo);
}

// Rotas que não exigem token. Tudo que não estiver aqui exige JWT válido.
const PUBLICAS: { metodo: string; padrao: RegExp }[] = [
  { metodo: 'POST', padrao: /^\/api\/(mobile|web)\/cadastro\/?$/ },
  { metodo: 'GET', padrao: /^\/api\/(mobile|web)\/info(\/.*)?$/ },
  { metodo: 'GET', padrao: /^\/api\/mobile\/diagnostico\/whoami\/?$/ },
];

// Rotas internas dos BFFs que nunca devem ser alcançadas de fora.
const BLOQUEADAS = /^\/api\/(mobile|web)\/auth(\/|$)/;

export async function autenticar(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const caminho = req.url.split('?')[0];
  // Evita contornar as regras acima com "..", ex.: /api/web/info/../painel
  if (/\.\.|%2e/i.test(caminho)) return void reply.code(400).send({ erro: 'caminho inválido' });
  if (BLOQUEADAS.test(caminho)) return void reply.code(404).send({ erro: 'rota não encontrada' });
  if (PUBLICAS.some((r) => r.metodo === req.method && r.padrao.test(caminho))) return;

  const cabecalho = req.headers.authorization ?? '';
  const [tipo, token] = cabecalho.split(' ');
  if (tipo !== 'Bearer' || !token) return void reply.code(401).send({ erro: 'token ausente' });
  try {
    const { payload } = await jwtVerify(token, config.jwt.segredo, { issuer: config.jwt.emissor, algorithms: ['HS256'] });
    req.usuario = { id: String(payload.sub), nome: String(payload.nome ?? '') };
  } catch {
    return void reply.code(401).send({ erro: 'token inválido ou expirado' });
  }
}

import http from 'node:http';
import type { FastifyInstance } from 'fastify';
import { config } from './config.js';
import { opcional, qs, svc, usuarioId } from './cliente.js';

interface Mobilizacao {
  id: string;
  titulo: string;
  dataHora: string;
  cidade: string;
  vagas: number | null;
  totalInteressados: number;
}

// Formato enxuto para as listas do app.
const card = (m: Mobilizacao) => ({
  id: m.id,
  titulo: m.titulo,
  dataHora: m.dataHora,
  cidade: m.cidade,
  totalInteressados: m.totalInteressados,
  vagasRestantes: m.vagas === null ? null : Math.max(m.vagas - m.totalInteressados, 0),
});

// Sem keep-alive (agent: false): cada chamada abre uma conexão nova e é balanceada
// de novo pelo Service do Kubernetes — é isso que permite ver a distribuição entre pods.
function whoamiSemKeepAlive(): Promise<{ pod: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${config.urls.mobilizacoes}/whoami`, { agent: false, timeout: config.timeoutMs }, (res) => {
      let corpo = '';
      res.on('data', (parte) => (corpo += parte));
      res.on('end', () => {
        try {
          resolve(JSON.parse(corpo));
        } catch (erro) {
          reject(erro);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

export async function rotas(app: FastifyInstance): Promise<void> {
  // ---------- públicas (o gateway libera sem token) ----------
  app.post('/cadastro', async (req, reply) => {
    const criado = await svc.doadores('/doadores', { metodo: 'POST', corpo: req.body });
    return reply.code(201).send(criado);
  });

  app.get('/info/faq', async (req) => svc.informacoes(`/faq${qs(req.query as Record<string, string>)}`));
  app.get('/info/hemocentros', async (req) => svc.informacoes(`/hemocentros${qs(req.query as Record<string, string>)}`));
  app.get('/info/conteudos', async (req) => svc.informacoes(`/conteudos${qs(req.query as Record<string, string>)}`));
  app.get<{ Params: { slug: string } }>('/info/conteudos/:slug', async (req) =>
    svc.informacoes(`/conteudos/${encodeURIComponent(req.params.slug)}`),
  );

  app.get('/diagnostico/whoami', async () => {
    const mob = await whoamiSemKeepAlive();
    return { bff: config.instancia, mobilizacoes: mob.pod };
  });

  // ---------- autenticadas ----------
  app.get('/inicio', async (req) => {
    const eu = usuarioId(req);
    const perfil = await svc.doadores<{ id: string; nome: string; cidade: string }>(`/doadores/${eu}`);
    const avisos: string[] = [];
    const [mobilizacoes, comunidades, dica] = await Promise.all([
      opcional(svc.mobilizacoes<Mobilizacao[]>(`/mobilizacoes${qs({ cidade: perfil.cidade, futuras: true })}`), avisos, 'mobilizações'),
      opcional(svc.comunidades<{ id: string; nome: string }[]>(`/comunidades${qs({ membro: eu })}`), avisos, 'comunidades'),
      opcional(svc.informacoes<{ titulo: string; resumo: string }>('/dicas/aleatoria'), avisos, 'dica do dia'),
    ]);
    return {
      usuario: { id: perfil.id, nome: perfil.nome, cidade: perfil.cidade },
      proximasMobilizacoes: mobilizacoes ? mobilizacoes.slice(0, 5).map(card) : null,
      minhasComunidades: comunidades ? comunidades.map((c) => ({ id: c.id, nome: c.nome })) : null,
      dica: dica ? { titulo: dica.titulo, resumo: dica.resumo } : null,
      avisos,
    };
  });

  app.get('/perfil', async (req) => svc.doadores(`/doadores/${usuarioId(req)}`));
  app.patch('/perfil', async (req) => svc.doadores(`/doadores/${usuarioId(req)}`, { metodo: 'PATCH', corpo: req.body }));

  app.get<{ Querystring: { cidade?: string } }>('/mobilizacoes', async (req) => {
    usuarioId(req);
    const lista = await svc.mobilizacoes<Mobilizacao[]>(`/mobilizacoes${qs({ cidade: req.query.cidade, futuras: true })}`);
    return lista.map(card);
  });

  app.get<{ Params: { id: string } }>('/mobilizacoes/:id', async (req) => {
    usuarioId(req);
    return svc.mobilizacoes(`/mobilizacoes/${req.params.id}`);
  });

  app.post<{ Params: { id: string } }>('/mobilizacoes/:id/interesse', async (req, reply) => {
    const r = await svc.mobilizacoes(`/mobilizacoes/${req.params.id}/interesses`, { metodo: 'POST', corpo: { doadorId: usuarioId(req) } });
    return reply.code(201).send(r);
  });

  app.delete<{ Params: { id: string } }>('/mobilizacoes/:id/interesse', async (req, reply) => {
    await svc.mobilizacoes(`/mobilizacoes/${req.params.id}/interesses/${usuarioId(req)}`, { metodo: 'DELETE' });
    return reply.code(204).send();
  });

  app.get<{ Querystring: { cidade?: string } }>('/comunidades', async (req) => {
    usuarioId(req);
    return svc.comunidades(`/comunidades${qs({ cidade: req.query.cidade })}`);
  });

  app.post<{ Params: { id: string } }>('/comunidades/:id/entrar', async (req, reply) => {
    const r = await svc.comunidades(`/comunidades/${req.params.id}/membros`, { metodo: 'POST', corpo: { doadorId: usuarioId(req) } });
    return reply.code(201).send(r);
  });

  app.delete<{ Params: { id: string } }>('/comunidades/:id/sair', async (req, reply) => {
    await svc.comunidades(`/comunidades/${req.params.id}/membros/${usuarioId(req)}`, { metodo: 'DELETE' });
    return reply.code(204).send();
  });
}

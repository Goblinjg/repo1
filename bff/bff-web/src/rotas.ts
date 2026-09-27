import type { FastifyInstance } from 'fastify';
import { opcional, qs, svc, usuarioId } from './cliente.js';

interface Comunidade {
  id: string;
  nome: string;
  cidade: string;
  uf: string;
}
interface Membro {
  doadorId: string;
  papel: 'admin' | 'membro';
  entrouEm: string;
}
interface Mobilizacao {
  id: string;
  comunidadeId: string;
  hemocentroId: string | null;
}

export async function rotas(app: FastifyInstance): Promise<void> {
  // ---------- interna: usada pelo gateway no login ----------
  app.post('/auth/verificar-credenciais', async (req) => svc.doadores('/auth/verificar', { metodo: 'POST', corpo: req.body }));

  // ---------- públicas ----------
  app.post('/cadastro', async (req, reply) => {
    const criado = await svc.doadores('/doadores', { metodo: 'POST', corpo: req.body });
    return reply.code(201).send(criado);
  });
  app.get('/info/conteudos', async (req) => svc.informacoes(`/conteudos${qs(req.query as Record<string, string>)}`));
  app.get('/info/hemocentros', async (req) => svc.informacoes(`/hemocentros${qs(req.query as Record<string, string>)}`));

  // ---------- autenticadas ----------
  app.get('/painel', async (req) => {
    const eu = usuarioId(req);
    const avisos: string[] = [];
    const [perfil, comunidades, interesses] = await Promise.all([
      svc.doadores(`/doadores/${eu}`),
      opcional(svc.comunidades<Comunidade[]>(`/comunidades${qs({ membro: eu })}`), avisos, 'comunidades'),
      opcional(svc.mobilizacoes(`/mobilizacoes${qs({ interessado: eu, futuras: true })}`), avisos, 'interesses'),
    ]);
    // Para cada comunidade: meu papel e as próximas mobilizações (chamadas em paralelo).
    const minhas = comunidades
      ? await Promise.all(
          comunidades.map(async (c) => {
            const [membros, mobilizacoes] = await Promise.all([
              opcional(svc.comunidades<Membro[]>(`/comunidades/${c.id}/membros`), avisos, `membros de ${c.nome}`),
              opcional(svc.mobilizacoes(`/mobilizacoes${qs({ comunidadeId: c.id, futuras: true })}`), avisos, `mobilizações de ${c.nome}`),
            ]);
            return { ...c, meuPapel: membros?.find((m) => m.doadorId === eu)?.papel ?? null, proximasMobilizacoes: mobilizacoes };
          }),
        )
      : null;
    return { perfil, comunidades: minhas, mobilizacoesComInteresse: interesses, avisos };
  });

  app.get<{ Querystring: { cidade?: string; uf?: string } }>('/comunidades', async (req) => {
    usuarioId(req);
    return svc.comunidades(`/comunidades${qs({ cidade: req.query.cidade, uf: req.query.uf })}`);
  });

  app.post('/comunidades', async (req, reply) => {
    const criada = await svc.comunidades('/comunidades', { metodo: 'POST', corpo: req.body, usuario: usuarioId(req) });
    return reply.code(201).send(criada);
  });

  app.get<{ Params: { id: string } }>('/comunidades/:id', async (req) => {
    usuarioId(req);
    const { id } = req.params;
    const avisos: string[] = [];
    const [comunidade, membros, mobilizacoes] = await Promise.all([
      svc.comunidades(`/comunidades/${id}`),
      svc.comunidades<Membro[]>(`/comunidades/${id}/membros`),
      opcional(svc.mobilizacoes(`/mobilizacoes${qs({ comunidadeId: id })}`), avisos, 'mobilizações'),
    ]);
    // Enriquecimento com o nome de cada membro (dado do doadores-service).
    const membrosComNome = await Promise.all(
      membros.map(async (m) => {
        const d = await opcional(svc.doadores<{ nome: string }>(`/doadores/${m.doadorId}`), [], '');
        return { ...m, nome: d?.nome ?? null };
      }),
    );
    return { ...comunidade, membros: membrosComNome, mobilizacoes, avisos };
  });

  app.post<{ Params: { id: string } }>('/comunidades/:id/membros', async (req, reply) => {
    const r = await svc.comunidades(`/comunidades/${req.params.id}/membros`, { metodo: 'POST', corpo: { doadorId: usuarioId(req) } });
    return reply.code(201).send(r);
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/comunidades/:id/mobilizacoes', async (req, reply) => {
    const eu = usuarioId(req);
    const [comunidade, membros] = await Promise.all([
      svc.comunidades<Comunidade>(`/comunidades/${req.params.id}`),
      svc.comunidades<Membro[]>(`/comunidades/${req.params.id}/membros`),
    ]);
    if (membros.find((m) => m.doadorId === eu)?.papel !== 'admin') {
      return reply.code(403).send({ erro: 'apenas administradores da comunidade podem criar mobilizações' });
    }
    const criada = await svc.mobilizacoes('/mobilizacoes', {
      metodo: 'POST',
      usuario: eu,
      corpo: { cidade: comunidade.cidade, uf: comunidade.uf, ...req.body, comunidadeId: comunidade.id },
    });
    return reply.code(201).send(criada);
  });

  app.get<{ Params: { id: string } }>('/mobilizacoes/:id', async (req) => {
    usuarioId(req);
    const mob = await svc.mobilizacoes<Mobilizacao>(`/mobilizacoes/${req.params.id}`);
    const avisos: string[] = [];
    const [hemocentro, comunidade] = await Promise.all([
      mob.hemocentroId ? opcional(svc.informacoes(`/hemocentros/${mob.hemocentroId}`), avisos, 'hemocentro') : null,
      opcional(svc.comunidades(`/comunidades/${mob.comunidadeId}`), avisos, 'comunidade'),
    ]);
    return { ...mob, hemocentro, comunidade, avisos };
  });
}

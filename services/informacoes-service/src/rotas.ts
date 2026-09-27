import type { FastifyInstance } from 'fastify';
import { pool } from './db.js';

const CATEGORIAS = ['requisitos', 'preparo', 'documentos', 'mitos', 'dica'];
const RESUMO = `slug, titulo, categoria, resumo`;
const COMPLETO = `${RESUMO}, corpo, atualizado_em AS "atualizadoEm"`;
const HEMOCENTRO = `id, nome, cidade, uf, endereco, telefone, horarios`;
const filtroCategoria = {
  type: 'object',
  properties: { categoria: { type: 'string', enum: CATEGORIAS } },
} as const;

export async function rotas(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { categoria?: string } }>('/conteudos', { schema: { querystring: filtroCategoria } }, async (req) => {
    const { rows } = await pool.query(
      `SELECT ${RESUMO} FROM conteudos WHERE ($1::text IS NULL OR categoria = $1) ORDER BY categoria, titulo`,
      [req.query.categoria ?? null],
    );
    return rows;
  });

  app.get<{ Params: { slug: string } }>('/conteudos/:slug', async (req, reply) => {
    const { rows } = await pool.query(`SELECT ${COMPLETO} FROM conteudos WHERE slug = $1`, [req.params.slug]);
    if (!rows[0]) return reply.code(404).send({ erro: 'conteúdo não encontrado' });
    return rows[0];
  });

  app.get('/dicas/aleatoria', async (_req, reply) => {
    const { rows } = await pool.query(`SELECT ${COMPLETO} FROM conteudos WHERE categoria = 'dica' ORDER BY random() LIMIT 1`);
    if (!rows[0]) return reply.code(404).send({ erro: 'nenhuma dica cadastrada' });
    return rows[0];
  });

  app.get<{ Querystring: { categoria?: string } }>('/faq', { schema: { querystring: filtroCategoria } }, async (req) => {
    const { rows } = await pool.query(
      `SELECT id, pergunta, resposta, categoria FROM faq WHERE ($1::text IS NULL OR categoria = $1) ORDER BY ordem`,
      [req.query.categoria ?? null],
    );
    return rows;
  });

  app.get<{ Querystring: { cidade?: string; uf?: string } }>('/hemocentros', async (req) => {
    const { cidade, uf } = req.query;
    const { rows } = await pool.query(
      `SELECT ${HEMOCENTRO} FROM hemocentros
        WHERE ($1::text IS NULL OR lower(cidade) = lower($1)) AND ($2::text IS NULL OR uf = upper($2))
        ORDER BY uf, cidade, nome`,
      [cidade ?? null, uf ?? null],
    );
    return rows;
  });

  app.get<{ Params: { id: string } }>(
    '/hemocentros/:id',
    { schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } } },
    async (req, reply) => {
      const { rows } = await pool.query(`SELECT ${HEMOCENTRO} FROM hemocentros WHERE id = $1`, [req.params.id]);
      if (!rows[0]) return reply.code(404).send({ erro: 'hemocentro não encontrado' });
      return rows[0];
    },
  );
}

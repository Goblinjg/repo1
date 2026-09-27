import type { FastifyInstance } from 'fastify';
import { pool } from './db.js';

const SELECT_COMUNIDADE = `
  SELECT c.id, c.nome, c.descricao, c.cidade, c.uf, c.criador_id AS "criadorId",
         (SELECT count(*)::int FROM membros m WHERE m.comunidade_id = c.id) AS "totalMembros",
         c.total_mobilizacoes AS "totalMobilizacoes", c.criado_em AS "criadoEm"
    FROM comunidades c`;

const uuid = { type: 'string', format: 'uuid' } as const;
const paramId = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const cabecalhoUsuario = { type: 'object', required: ['x-user-id'], properties: { 'x-user-id': uuid } } as const;

interface NovaComunidade {
  nome: string;
  descricao?: string;
  cidade: string;
  uf: string;
}

export async function rotas(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { cidade?: string; uf?: string; membro?: string } }>(
    '/comunidades',
    { schema: { querystring: { type: 'object', properties: { cidade: { type: 'string' }, uf: { type: 'string' }, membro: uuid } } } },
    async (req) => {
      const { cidade, uf, membro } = req.query;
      const { rows } = await pool.query(
        `${SELECT_COMUNIDADE}
          WHERE ($1::text IS NULL OR lower(c.cidade) = lower($1))
            AND ($2::text IS NULL OR c.uf = upper($2))
            AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM membros m WHERE m.comunidade_id = c.id AND m.doador_id = $3))
          ORDER BY c.nome LIMIT 200`,
        [cidade ?? null, uf ?? null, membro ?? null],
      );
      return rows;
    },
  );

  app.post<{ Body: NovaComunidade; Headers: { 'x-user-id': string } }>(
    '/comunidades',
    {
      schema: {
        headers: cabecalhoUsuario,
        body: {
          type: 'object',
          required: ['nome', 'cidade', 'uf'],
          additionalProperties: false,
          properties: {
            nome: { type: 'string', minLength: 3 },
            descricao: { type: 'string' },
            cidade: { type: 'string', minLength: 2 },
            uf: { type: 'string', minLength: 2, maxLength: 2 },
          },
        },
      },
    },
    async (req, reply) => {
      const criador = req.headers['x-user-id'];
      const cliente = await pool.connect();
      try {
        await cliente.query('BEGIN');
        const { rows } = await cliente.query<{ id: string }>(
          `INSERT INTO comunidades (nome, descricao, cidade, uf, criador_id)
           VALUES ($1, $2, $3, upper($4), $5) RETURNING id`,
          [req.body.nome, req.body.descricao ?? null, req.body.cidade, req.body.uf, criador],
        );
        await cliente.query(`INSERT INTO membros (comunidade_id, doador_id, papel) VALUES ($1, $2, 'admin')`, [rows[0].id, criador]);
        await cliente.query('COMMIT');
        const criada = await pool.query(`${SELECT_COMUNIDADE} WHERE c.id = $1`, [rows[0].id]);
        return reply.code(201).send(criada.rows[0]);
      } catch (erro) {
        await cliente.query('ROLLBACK');
        throw erro;
      } finally {
        cliente.release();
      }
    },
  );

  app.get<{ Params: { id: string } }>('/comunidades/:id', { schema: { params: paramId } }, async (req, reply) => {
    const { rows } = await pool.query(`${SELECT_COMUNIDADE} WHERE c.id = $1`, [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ erro: 'comunidade não encontrada' });
    return rows[0];
  });

  app.get<{ Params: { id: string } }>('/comunidades/:id/membros', { schema: { params: paramId } }, async (req, reply) => {
    const existe = await pool.query('SELECT 1 FROM comunidades WHERE id = $1', [req.params.id]);
    if (!existe.rowCount) return reply.code(404).send({ erro: 'comunidade não encontrada' });
    const { rows } = await pool.query(
      `SELECT doador_id AS "doadorId", papel, entrou_em AS "entrouEm"
         FROM membros WHERE comunidade_id = $1 ORDER BY papel, entrou_em`,
      [req.params.id],
    );
    return rows;
  });

  app.post<{ Params: { id: string }; Body: { doadorId: string } }>(
    '/comunidades/:id/membros',
    {
      schema: {
        params: paramId,
        body: { type: 'object', required: ['doadorId'], properties: { doadorId: uuid } },
      },
    },
    async (req, reply) => {
      const existe = await pool.query('SELECT 1 FROM comunidades WHERE id = $1', [req.params.id]);
      if (!existe.rowCount) return reply.code(404).send({ erro: 'comunidade não encontrada' });
      const { rows } = await pool.query(
        `INSERT INTO membros (comunidade_id, doador_id, papel) VALUES ($1, $2, 'membro')
         RETURNING doador_id AS "doadorId", papel, entrou_em AS "entrouEm"`,
        [req.params.id, req.body.doadorId],
      );
      return reply.code(201).send(rows[0]);
    },
  );

  app.delete<{ Params: { id: string; doadorId: string } }>(
    '/comunidades/:id/membros/:doadorId',
    { schema: { params: { type: 'object', required: ['id', 'doadorId'], properties: { id: uuid, doadorId: uuid } } } },
    async (req, reply) => {
      const { rowCount } = await pool.query('DELETE FROM membros WHERE comunidade_id = $1 AND doador_id = $2', [
        req.params.id,
        req.params.doadorId,
      ]);
      if (!rowCount) return reply.code(404).send({ erro: 'não é membro' });
      return reply.code(204).send();
    },
  );
}

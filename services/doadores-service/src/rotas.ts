import type { FastifyInstance } from 'fastify';
import { pool } from './db.js';
import { conferir, gerarHash } from './senha.js';

const COLUNAS = `id, nome, email, tipo_sanguineo AS "tipoSanguineo", cidade, uf,
  to_char(data_ultima_doacao, 'YYYY-MM-DD') AS "dataUltimaDoacao", criado_em AS "criadoEm"`;

const tipoSanguineo = { type: ['string', 'null'], enum: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', null] };
const camposPerfil = {
  nome: { type: 'string', minLength: 2 },
  tipoSanguineo,
  cidade: { type: 'string', minLength: 2 },
  uf: { type: 'string', minLength: 2, maxLength: 2 },
  dataUltimaDoacao: { type: ['string', 'null'], format: 'date' },
};
const paramId = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

interface NovoDoador {
  nome: string;
  email: string;
  senha: string;
  tipoSanguineo?: string | null;
  cidade: string;
  uf: string;
  dataUltimaDoacao?: string | null;
}

export async function rotas(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { cidade?: string; uf?: string } }>('/doadores', async (req) => {
    const { cidade, uf } = req.query;
    const { rows } = await pool.query(
      `SELECT ${COLUNAS} FROM doadores
        WHERE ($1::text IS NULL OR lower(cidade) = lower($1))
          AND ($2::text IS NULL OR uf = upper($2))
        ORDER BY nome LIMIT 200`,
      [cidade ?? null, uf ?? null],
    );
    return rows;
  });

  app.post<{ Body: NovoDoador }>(
    '/doadores',
    {
      schema: {
        body: {
          type: 'object',
          required: ['nome', 'email', 'senha', 'cidade', 'uf'],
          additionalProperties: false,
          properties: { ...camposPerfil, email: { type: 'string', format: 'email' }, senha: { type: 'string', minLength: 8 } },
        },
      },
    },
    async (req, reply) => {
      const d = req.body;
      const { rows } = await pool.query(
        `INSERT INTO doadores (nome, email, senha_hash, tipo_sanguineo, cidade, uf, data_ultima_doacao)
         VALUES ($1, lower($2), $3, $4, $5, upper($6), $7) RETURNING ${COLUNAS}`,
        [d.nome, d.email, await gerarHash(d.senha), d.tipoSanguineo ?? null, d.cidade, d.uf, d.dataUltimaDoacao ?? null],
      );
      return reply.code(201).send(rows[0]);
    },
  );

  app.get<{ Params: { id: string } }>('/doadores/:id', { schema: { params: paramId } }, async (req, reply) => {
    const { rows } = await pool.query(`SELECT ${COLUNAS} FROM doadores WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ erro: 'doador não encontrado' });
    return rows[0];
  });

  app.patch<{ Params: { id: string }; Body: Partial<NovoDoador> }>(
    '/doadores/:id',
    {
      schema: {
        params: paramId,
        body: { type: 'object', additionalProperties: false, minProperties: 1, properties: camposPerfil },
      },
    },
    async (req, reply) => {
      const colunas: Record<string, string> = {
        nome: 'nome',
        tipoSanguineo: 'tipo_sanguineo',
        cidade: 'cidade',
        uf: 'uf',
        dataUltimaDoacao: 'data_ultima_doacao',
      };
      const sets: string[] = [];
      const valores: unknown[] = [];
      for (const [campo, valor] of Object.entries(req.body)) {
        valores.push(campo === 'uf' ? String(valor).toUpperCase() : valor);
        sets.push(`${colunas[campo]} = $${valores.length}`);
      }
      valores.push(req.params.id);
      const { rows } = await pool.query(
        `UPDATE doadores SET ${sets.join(', ')}, atualizado_em = now() WHERE id = $${valores.length} RETURNING ${COLUNAS}`,
        valores,
      );
      if (!rows[0]) return reply.code(404).send({ erro: 'doador não encontrado' });
      return rows[0];
    },
  );

  app.post<{ Body: { email: string; senha: string } }>(
    '/auth/verificar',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'senha'],
          properties: { email: { type: 'string' }, senha: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const { rows } = await pool.query<{ id: string; nome: string; email: string; senha_hash: string | null }>(
        'SELECT id, nome, email, senha_hash FROM doadores WHERE email = lower($1)',
        [req.body.email],
      );
      const doador = rows[0];
      if (!doador || !(await conferir(req.body.senha, doador.senha_hash))) {
        return reply.code(401).send({ erro: 'credenciais inválidas' });
      }
      return { id: doador.id, nome: doador.nome, email: doador.email };
    },
  );
}

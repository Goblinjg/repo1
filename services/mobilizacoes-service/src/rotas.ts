import type { FastifyInstance } from 'fastify';
import { config } from './config.js';
import { pool } from './db.js';
import { criarEvento, publicar, type Evento } from './broker.js';

const SELECT_MOBILIZACAO = `
  SELECT m.id, m.comunidade_id AS "comunidadeId", m.titulo, m.descricao, m.data_hora AS "dataHora",
         m.cidade, m.uf, m.hemocentro_id AS "hemocentroId", m.local, m.vagas,
         (SELECT count(*)::int FROM interesses i WHERE i.mobilizacao_id = m.id) AS "totalInteressados",
         m.criador_id AS "criadorId", m.criado_em AS "criadoEm"
    FROM mobilizacoes m`;

const uuid = { type: 'string', format: 'uuid' } as const;
const paramId = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const iniciadoEm = new Date().toISOString();

interface NovaMobilizacao {
  comunidadeId: string;
  titulo: string;
  descricao?: string;
  dataHora: string;
  cidade: string;
  uf: string;
  hemocentroId?: string | null;
  local?: string;
  vagas?: number | null;
}

export async function rotas(app: FastifyInstance): Promise<void> {
  // Publica após o commit. Se o broker falhar, o evento fica pendente na outbox
  // para o relay da Parte 4 — assim ele não se perde.
  async function publicarOuGuardar(evento: Evento, agregadoId: string): Promise<void> {
    try {
      await publicar(evento);
      app.log.info({ eventoId: evento.id, tipo: evento.tipo }, 'evento publicado');
    } catch (erro) {
      app.log.error({ err: (erro as Error).message, eventoId: evento.id }, 'falha ao publicar; evento guardado na outbox');
      await pool.query(
        `INSERT INTO outbox (id, agregado, agregado_id, tipo, payload) VALUES ($1, 'mobilizacao', $2, $3, $4)`,
        [evento.id, agregadoId, evento.tipo, JSON.stringify(evento)],
      );
    }
  }

  app.get('/whoami', async () => ({ servico: config.servico, pod: config.instancia, iniciadoEm }));

  app.get<{ Querystring: { comunidadeId?: string; cidade?: string; interessado?: string; futuras?: boolean } }>(
    '/mobilizacoes',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { comunidadeId: uuid, cidade: { type: 'string' }, interessado: uuid, futuras: { type: 'boolean', default: false } },
        },
      },
    },
    async (req) => {
      const { comunidadeId, cidade, interessado, futuras } = req.query;
      const { rows } = await pool.query(
        `${SELECT_MOBILIZACAO}
          WHERE ($1::uuid IS NULL OR m.comunidade_id = $1)
            AND ($2::text IS NULL OR lower(m.cidade) = lower($2))
            AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM interesses i WHERE i.mobilizacao_id = m.id AND i.doador_id = $3))
            AND (NOT $4 OR m.data_hora >= now())
          ORDER BY m.data_hora LIMIT 200`,
        [comunidadeId ?? null, cidade ?? null, interessado ?? null, futuras ?? false],
      );
      return rows;
    },
  );

  app.post<{ Body: NovaMobilizacao; Headers: { 'x-user-id': string } }>(
    '/mobilizacoes',
    {
      schema: {
        headers: { type: 'object', required: ['x-user-id'], properties: { 'x-user-id': uuid } },
        body: {
          type: 'object',
          required: ['comunidadeId', 'titulo', 'dataHora', 'cidade', 'uf'],
          additionalProperties: false,
          properties: {
            comunidadeId: uuid,
            titulo: { type: 'string', minLength: 3 },
            descricao: { type: 'string' },
            dataHora: { type: 'string', format: 'date-time' },
            cidade: { type: 'string', minLength: 2 },
            uf: { type: 'string', minLength: 2, maxLength: 2 },
            hemocentroId: { type: ['string', 'null'], format: 'uuid' },
            local: { type: 'string' },
            vagas: { type: ['integer', 'null'], minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const m = req.body;
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO mobilizacoes (comunidade_id, titulo, descricao, data_hora, cidade, uf, hemocentro_id, local, vagas, criador_id)
         VALUES ($1, $2, $3, $4, $5, upper($6), $7, $8, $9, $10) RETURNING id`,
        [m.comunidadeId, m.titulo, m.descricao ?? null, m.dataHora, m.cidade, m.uf, m.hemocentroId ?? null, m.local ?? null, m.vagas ?? null, req.headers['x-user-id']],
      );
      const id = rows[0].id;
      await publicarOuGuardar(
        criarEvento('mobilizacao.criada', { mobilizacaoId: id, comunidadeId: m.comunidadeId, dataHora: m.dataHora }),
        id,
      );
      const criada = await pool.query(`${SELECT_MOBILIZACAO} WHERE m.id = $1`, [id]);
      return reply.code(201).send(criada.rows[0]);
    },
  );

  app.get<{ Params: { id: string } }>('/mobilizacoes/:id', { schema: { params: paramId } }, async (req, reply) => {
    const { rows } = await pool.query(`${SELECT_MOBILIZACAO} WHERE m.id = $1`, [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ erro: 'mobilização não encontrada' });
    return rows[0];
  });

  app.post<{ Params: { id: string }; Body: { doadorId: string } }>(
    '/mobilizacoes/:id/interesses',
    { schema: { params: paramId, body: { type: 'object', required: ['doadorId'], properties: { doadorId: uuid } } } },
    async (req, reply) => {
      const cliente = await pool.connect();
      try {
        await cliente.query('BEGIN');
        // FOR UPDATE serializa inscrições concorrentes na mesma mobilização (controle de vagas).
        const mob = await cliente.query<{ vagas: number | null; comunidade_id: string }>(
          'SELECT vagas, comunidade_id FROM mobilizacoes WHERE id = $1 FOR UPDATE',
          [req.params.id],
        );
        if (!mob.rows[0]) {
          await cliente.query('ROLLBACK');
          return reply.code(404).send({ erro: 'mobilização não encontrada' });
        }
        const { vagas } = mob.rows[0];
        if (vagas !== null) {
          const total = await cliente.query<{ n: number }>('SELECT count(*)::int AS n FROM interesses WHERE mobilizacao_id = $1', [req.params.id]);
          if (total.rows[0].n >= vagas) {
            await cliente.query('ROLLBACK');
            return reply.code(422).send({ erro: 'vagas esgotadas' });
          }
        }
        const { rows } = await cliente.query(
          `INSERT INTO interesses (mobilizacao_id, doador_id) VALUES ($1, $2)
           RETURNING mobilizacao_id AS "mobilizacaoId", doador_id AS "doadorId", criado_em AS "criadoEm"`,
          [req.params.id, req.body.doadorId],
        );
        await cliente.query('COMMIT');
        await publicarOuGuardar(
          criarEvento('mobilizacao.interesse-registrado', { mobilizacaoId: req.params.id, doadorId: req.body.doadorId }),
          req.params.id,
        );
        return reply.code(201).send(rows[0]);
      } catch (erro) {
        await cliente.query('ROLLBACK').catch(() => {});
        throw erro;
      } finally {
        cliente.release();
      }
    },
  );

  app.delete<{ Params: { id: string; doadorId: string } }>(
    '/mobilizacoes/:id/interesses/:doadorId',
    { schema: { params: { type: 'object', required: ['id', 'doadorId'], properties: { id: uuid, doadorId: uuid } } } },
    async (req, reply) => {
      const { rowCount } = await pool.query('DELETE FROM interesses WHERE mobilizacao_id = $1 AND doador_id = $2', [
        req.params.id,
        req.params.doadorId,
      ]);
      if (!rowCount) return reply.code(404).send({ erro: 'interesse não encontrado' });
      return reply.code(204).send();
    },
  );
}

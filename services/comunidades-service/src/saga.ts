// Participante da SAGA "criar mobilização confirmada": T2 (reservar data) e C2 (liberar data).
// Consome saga.comunidades.comandos com prefetch 1 (ordem preservada) e responde pela outbox,
// na mesma transação que altera o calendário.
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { Evento } from './broker.js';
import { emTransacao, gravarNaOutbox, primeiraVez } from './outbox/relay.js';

interface Comando {
  sagaId: string;
  mobilizacaoId?: string;
  comunidadeId?: string;
  criadorId?: string;
  dataHora?: string;
}

const responder = (c: pg.PoolClient, sagaId: string, resposta: string, motivo?: string) =>
  gravarNaOutbox(c, { agregado: 'saga', agregadoId: sagaId, tipo: `saga.resposta.${resposta}`, dados: { sagaId, motivo } });

export function participanteSaga(log: FastifyBaseLogger) {
  return async (evento: Evento): Promise<void> => {
    const cmd = evento.dados as Comando;
    await emTransacao(async (c) => {
      if (!(await primeiraVez(c, evento, 'saga'))) return;

      if (evento.tipo === 'saga.comunidades.reservar-data') {
        // repetição do mesmo comando: já reservado para esta saga
        const ja = await c.query('SELECT 1 FROM reservas_calendario WHERE saga_id = $1', [cmd.sagaId]);
        if (ja.rowCount) return void (await responder(c, cmd.sagaId, 'data-reservada'));

        // autorização SEMPRE no modelo de escrita (nunca na projeção do painel)
        const papel = await c.query<{ papel: string }>(
          'SELECT papel FROM membros WHERE comunidade_id = $1 AND doador_id = $2',
          [cmd.comunidadeId, cmd.criadorId],
        );
        if (papel.rows[0]?.papel !== 'admin') {
          log.warn({ sagaId: cmd.sagaId }, 'T2 recusado: criador não é admin');
          return void (await responder(c, cmd.sagaId, 'data-recusada', 'o criador não é administrador da comunidade'));
        }

        const r = await c.query<{ data: string }>(
          `INSERT INTO reservas_calendario (comunidade_id, data, saga_id, mobilizacao_id)
           VALUES ($1, ($2::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date, $3, $4)
           ON CONFLICT (comunidade_id, data) DO NOTHING
           RETURNING to_char(data, 'DD/MM/YYYY') AS data`,
          [cmd.comunidadeId, cmd.dataHora, cmd.sagaId, cmd.mobilizacaoId],
        );
        if (!r.rows[0]) {
          log.warn({ sagaId: cmd.sagaId }, 'T2 recusado: data ocupada');
          return void (await responder(c, cmd.sagaId, 'data-recusada', 'a comunidade já tem uma mobilização neste dia'));
        }
        log.info({ sagaId: cmd.sagaId, data: r.rows[0].data }, 'T2: data reservada');
        return void (await responder(c, cmd.sagaId, 'data-reservada'));
      }

      if (evento.tipo === 'saga.comunidades.liberar-data') {
        // C2 idempotente: apagar o que já não existe não muda nada
        const r = await c.query('DELETE FROM reservas_calendario WHERE saga_id = $1', [cmd.sagaId]);
        log.info({ sagaId: cmd.sagaId, removidas: r.rowCount }, 'C2: data liberada');
        return void (await responder(c, cmd.sagaId, 'data-liberada'));
      }

      log.warn({ tipo: evento.tipo }, 'comando desconhecido ignorado');
    });
  };
}

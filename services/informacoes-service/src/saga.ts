// Participante da SAGA "criar mobilização confirmada": T3 (reservar janela no hemocentro, o
// passo pivô) e C3 (liberar a janela). Consome saga.informacoes.comandos com prefetch 1 e
// responde pela outbox, na mesma transação que altera as reservas.
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { Evento } from './broker.js';
import { emTransacao, gravarNaOutbox, primeiraVez } from './outbox/relay.js';

interface Comando {
  sagaId: string;
  mobilizacaoId?: string;
  hemocentroId?: string;
  dataHora?: string;
}

const responder = (c: pg.PoolClient, sagaId: string, resposta: string, motivo?: string) =>
  gravarNaOutbox(c, { agregado: 'saga', agregadoId: sagaId, tipo: `saga.resposta.${resposta}`, dados: { sagaId, motivo } });

export function participanteSaga(log: FastifyBaseLogger) {
  return async (evento: Evento): Promise<void> => {
    const cmd = evento.dados as Comando;
    await emTransacao(async (c) => {
      if (!(await primeiraVez(c, evento, 'saga'))) return;

      if (evento.tipo === 'saga.informacoes.reservar-janela') {
        const ja = await c.query('SELECT 1 FROM reservas_hemocentro WHERE saga_id = $1', [cmd.sagaId]);
        if (ja.rowCount) return void (await responder(c, cmd.sagaId, 'janela-reservada'));

        // FOR UPDATE no hemocentro serializa reservas concorrentes para o mesmo hemocentro
        const h = await c.query<{ nome: string; capacidade_diaria: number }>(
          'SELECT nome, capacidade_diaria FROM hemocentros WHERE id = $1 FOR UPDATE',
          [cmd.hemocentroId],
        );
        if (!h.rows[0]) return void (await responder(c, cmd.sagaId, 'janela-recusada', 'hemocentro não encontrado'));

        const dia = `($1::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date`;
        const ocupadas = await c.query<{ n: number; data: string }>(
          `SELECT count(r.id)::int AS n, to_char(${dia}, 'DD/MM/YYYY') AS data
             FROM (SELECT 1) x LEFT JOIN reservas_hemocentro r ON r.hemocentro_id = $2 AND r.data = ${dia}`,
          [cmd.dataHora, cmd.hemocentroId],
        );
        const { n, data } = ocupadas.rows[0];
        if (n >= h.rows[0].capacidade_diaria) {
          log.warn({ sagaId: cmd.sagaId, hemocentro: h.rows[0].nome, data, ocupadas: n }, 'T3 recusado: sem capacidade');
          return void (await responder(
            c,
            cmd.sagaId,
            'janela-recusada',
            `${h.rows[0].nome} sem capacidade em ${data} (${n}/${h.rows[0].capacidade_diaria} janelas ocupadas)`,
          ));
        }
        await c.query(
          `INSERT INTO reservas_hemocentro (hemocentro_id, data, saga_id, mobilizacao_id) VALUES ($1, ${dia.replace('$1', '$2')}, $3, $4)`,
          [cmd.hemocentroId, cmd.dataHora, cmd.sagaId, cmd.mobilizacaoId],
        );
        log.info({ sagaId: cmd.sagaId, hemocentro: h.rows[0].nome, data }, 'T3: janela reservada');
        return void (await responder(c, cmd.sagaId, 'janela-reservada'));
      }

      if (evento.tipo === 'saga.informacoes.liberar-janela') {
        const r = await c.query('DELETE FROM reservas_hemocentro WHERE saga_id = $1', [cmd.sagaId]);
        log.info({ sagaId: cmd.sagaId, removidas: r.rowCount }, 'C3: janela liberada');
        return void (await responder(c, cmd.sagaId, 'janela-liberada'));
      }

      log.warn({ tipo: evento.tipo }, 'comando desconhecido ignorado');
    });
  };
}

// Orquestrador da SAGA "criar mobilização confirmada".
//
//   T1 mobilizacoes  cria a mobilização PENDENTE e a saga            (local, nesta transação)
//   T2 comunidades   valida admin e reserva a data no calendário      (comando → resposta)
//   T3 informacoes   reserva a janela de coleta no hemocentro (pivô)  (comando → resposta)
//   T4 mobilizacoes  CONFIRMADA + outbox mobilizacao.criada           (local, re-tentado até concluir)
//
// Compensações em ordem reversa: C3 libera a janela, C2 libera a data, C1 cancela a mobilização.
// Todo comando sai pela outbox, na mesma transação que muda o estado da saga: não existe
// um momento em que a saga avançou e o comando não foi registrado (ou vice-versa).
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { Evento } from '../broker.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { emTransacao, gravarNaOutbox, primeiraVez } from '../outbox/relay.js';
import type { ContextoSaga, EstadoSaga, NomePasso, OrquestradorSaga, PassoSaga, RespostaSaga } from './contratos.js';

interface LinhaSaga {
  id: string;
  mobilizacao_id: string;
  estado: EstadoSaga;
  passo: NomePasso | 'fim';
  concluidos: NomePasso[];
  compensar: NomePasso[];
  motivo: string | null;
  dados: ContextoSaga;
  tentativas: number;
}

const comando = (cliente: pg.PoolClient, sagaId: string, tipo: string, dados: Record<string, unknown> = {}) =>
  gravarNaOutbox(cliente, { agregado: 'saga', agregadoId: sagaId, tipo, dados: { sagaId, ...dados } }).then(() => undefined);

const PASSOS: Record<NomePasso, PassoSaga<ContextoSaga> & { transacao: string; compensacao: string }> = {
  data: {
    nome: 'data',
    transacao: 'T2',
    compensacao: 'C2',
    descricao: 'comunidades: validar admin e reservar a data',
    executar: (c, id, ctx) =>
      comando(c, id, 'saga.comunidades.reservar-data', {
        mobilizacaoId: ctx.mobilizacaoId,
        comunidadeId: ctx.comunidadeId,
        criadorId: ctx.criadorId,
        dataHora: ctx.dataHora,
      }),
    compensar: (c, id) => comando(c, id, 'saga.comunidades.liberar-data'),
    respostas: {
      sucesso: 'saga.resposta.data-reservada',
      recusa: 'saga.resposta.data-recusada',
      compensado: 'saga.resposta.data-liberada',
    },
  },
  janela: {
    nome: 'janela',
    transacao: 'T3',
    compensacao: 'C3',
    descricao: 'informacoes: reservar a janela de coleta no hemocentro',
    executar: (c, id, ctx) =>
      comando(c, id, 'saga.informacoes.reservar-janela', {
        mobilizacaoId: ctx.mobilizacaoId,
        hemocentroId: ctx.hemocentroId,
        dataHora: ctx.dataHora,
      }),
    compensar: (c, id) => comando(c, id, 'saga.informacoes.liberar-janela'),
    respostas: {
      sucesso: 'saga.resposta.janela-reservada',
      recusa: 'saga.resposta.janela-recusada',
      compensado: 'saga.resposta.janela-liberada',
    },
  },
};

// Sem hemocentro informado não há janela para reservar: a saga vai de T2 direto para T4.
function proximoPasso(atual: NomePasso | null, ctx: ContextoSaga): NomePasso | null {
  if (atual === null) return 'data';
  if (atual === 'data' && ctx.hemocentroId) return 'janela';
  return null;
}

const registrar = (c: pg.PoolClient, sagaId: string, etapa: string, descricao: string) =>
  c.query('INSERT INTO saga_historico (saga_id, etapa, descricao) VALUES ($1, $2, $3)', [sagaId, etapa, descricao]);

const prazo = (ms: number) => `now() + interval '${Math.round(ms)} milliseconds'`;

export function criarOrquestrador(log: FastifyBaseLogger) {
  const timeoutMs = config.saga.timeoutMs;

  async function executarPasso(c: pg.PoolClient, saga: LinhaSaga, nome: NomePasso): Promise<void> {
    const passo = PASSOS[nome];
    await passo.executar(c, saga.id, saga.dados);
    await c.query(
      `UPDATE sagas SET estado = 'EM_ANDAMENTO', passo = $2, prazo_em = ${prazo(timeoutMs)}, tentativas = 0, atualizado_em = now()
        WHERE id = $1`,
      [saga.id, nome],
    );
    await registrar(c, saga.id, passo.transacao, `comando enviado (${passo.descricao}); prazo de ${timeoutMs / 1000}s`);
    saga.estado = 'EM_ANDAMENTO';
    saga.passo = nome;
  }

  // T4: passo final local. Se a transação falhar, a resposta volta para a fila e T4 é re-tentado.
  async function confirmar(c: pg.PoolClient, saga: LinhaSaga): Promise<void> {
    const { rows } = await c.query<{ titulo: string }>(
      `UPDATE mobilizacoes SET estado = 'CONFIRMADA' WHERE id = $1 AND estado = 'PENDENTE' RETURNING titulo`,
      [saga.mobilizacao_id],
    );
    if (rows[0]) {
      await gravarNaOutbox(c, {
        agregado: 'mobilizacao',
        agregadoId: saga.mobilizacao_id,
        tipo: 'mobilizacao.criada',
        dados: {
          mobilizacaoId: saga.mobilizacao_id,
          comunidadeId: saga.dados.comunidadeId,
          titulo: rows[0].titulo,
          dataHora: saga.dados.dataHora,
        },
      });
    }
    await c.query(
      `UPDATE sagas SET estado = 'CONCLUIDA', passo = 'fim', prazo_em = NULL, atualizado_em = now() WHERE id = $1`,
      [saga.id],
    );
    await registrar(c, saga.id, 'T4', 'mobilização CONFIRMADA; evento mobilizacao.criada gravado na outbox');
    log.info({ sagaId: saga.id, mobilizacaoId: saga.mobilizacao_id }, 'saga CONCLUIDA');
  }

  // C1: compensação local, a última da fila.
  async function cancelar(c: pg.PoolClient, saga: LinhaSaga): Promise<void> {
    const motivo = saga.motivo ?? 'saga compensada';
    await c.query(
      `UPDATE mobilizacoes SET estado = 'CANCELADA', motivo_cancelamento = $2 WHERE id = $1 AND estado <> 'CANCELADA'`,
      [saga.mobilizacao_id, motivo],
    );
    await gravarNaOutbox(c, {
      agregado: 'mobilizacao',
      agregadoId: saga.mobilizacao_id,
      tipo: 'mobilizacao.cancelada',
      dados: { mobilizacaoId: saga.mobilizacao_id, comunidadeId: saga.dados.comunidadeId, motivo },
    });
    await c.query(
      `UPDATE sagas SET estado = 'COMPENSADA', passo = 'fim', compensar = '{}', prazo_em = NULL, atualizado_em = now() WHERE id = $1`,
      [saga.id],
    );
    await registrar(c, saga.id, 'C1', `mobilização CANCELADA (motivo: ${motivo})`);
    log.warn({ sagaId: saga.id, mobilizacaoId: saga.mobilizacao_id, motivo }, 'saga COMPENSADA');
  }

  async function proximaCompensacao(c: pg.PoolClient, saga: LinhaSaga, fila: NomePasso[]): Promise<void> {
    if (fila.length === 0) return cancelar(c, saga);
    const passo = PASSOS[fila[0]];
    await passo.compensar(c, saga.id, saga.dados);
    await c.query(
      `UPDATE sagas SET passo = $2, compensar = $3, prazo_em = ${prazo(timeoutMs)}, tentativas = 0, atualizado_em = now() WHERE id = $1`,
      [saga.id, passo.nome, fila],
    );
    await registrar(c, saga.id, passo.compensacao, `comando de compensação enviado (desfazer ${passo.transacao})`);
  }

  // Antes do pivô, uma falha desfaz os passos concluídos em ordem reversa. Num timeout o
  // participante pode ter executado sem responder, então o passo atual também é compensado
  // (as compensações são idempotentes: desfazer o que não existe não muda nada).
  async function iniciarCompensacao(c: pg.PoolClient, saga: LinhaSaga, motivo: string, incluirAtual: boolean): Promise<void> {
    const fila = [...saga.concluidos].reverse();
    if (incluirAtual && saga.passo !== 'fim' && !fila.includes(saga.passo)) fila.unshift(saga.passo);
    await c.query(`UPDATE sagas SET estado = 'COMPENSANDO', motivo = $2, atualizado_em = now() WHERE id = $1`, [saga.id, motivo]);
    await registrar(c, saga.id, 'COMPENSANDO', `${motivo}; compensações: ${[...fila.map((p) => PASSOS[p].compensacao), 'C1'].join(' → ')}`);
    saga.estado = 'COMPENSANDO';
    saga.motivo = motivo;
    log.warn({ sagaId: saga.id, motivo, fila }, 'saga COMPENSANDO');
    await proximaCompensacao(c, saga, fila);
  }

  const iniciar: OrquestradorSaga<ContextoSaga>['iniciar'] = async (c, contexto) => {
    const sagaId = randomUUID();
    const saga: LinhaSaga = {
      id: sagaId,
      mobilizacao_id: contexto.mobilizacaoId,
      estado: 'INICIADA',
      passo: 'data',
      concluidos: [],
      compensar: [],
      motivo: null,
      dados: contexto,
      tentativas: 0,
    };
    await c.query(`INSERT INTO sagas (id, mobilizacao_id, estado, passo, dados) VALUES ($1, $2, 'INICIADA', 'data', $3)`, [
      sagaId,
      contexto.mobilizacaoId,
      JSON.stringify(contexto),
    ]);
    await registrar(c, sagaId, 'T1', 'mobilização gravada como PENDENTE; saga INICIADA');
    await executarPasso(c, saga, proximoPasso(null, contexto)!);
    return { sagaId, estado: saga.estado };
  };

  // Consumidor da fila saga.mobilizacoes.respostas.
  async function aoResponder(evento: Evento): Promise<void> {
    const { sagaId, motivo } = evento.dados as RespostaSaga;
    await emTransacao(async (c) => {
      if (!(await primeiraVez(c, evento, 'orquestrador'))) return;
      const { rows } = await c.query<LinhaSaga>('SELECT * FROM sagas WHERE id = $1 FOR UPDATE', [sagaId]);
      const saga = rows[0];
      if (!saga) {
        log.warn({ sagaId, tipo: evento.tipo }, 'resposta para saga desconhecida');
        return;
      }
      const passo = saga.passo === 'fim' ? null : PASSOS[saga.passo];

      if (saga.estado === 'EM_ANDAMENTO' && passo && evento.tipo === passo.respostas.sucesso) {
        await c.query('UPDATE sagas SET concluidos = array_append(concluidos, $2) WHERE id = $1', [saga.id, passo.nome]);
        saga.concluidos.push(passo.nome);
        await registrar(c, saga.id, passo.transacao, `concluído (${evento.tipo.replace('saga.resposta.', '')})`);
        const proximo = proximoPasso(passo.nome, saga.dados);
        if (proximo) await executarPasso(c, saga, proximo);
        else await confirmar(c, saga);
        return;
      }

      if (saga.estado === 'EM_ANDAMENTO' && passo && evento.tipo === passo.respostas.recusa) {
        await registrar(c, saga.id, passo.transacao, `recusado: ${motivo ?? 'sem motivo'}`);
        await iniciarCompensacao(c, saga, `${passo.transacao} recusado: ${motivo ?? 'sem motivo'}`, false);
        return;
      }

      if (saga.estado === 'COMPENSANDO' && passo && evento.tipo === passo.respostas.compensado) {
        await registrar(c, saga.id, passo.compensacao, `compensação confirmada (${evento.tipo.replace('saga.resposta.', '')})`);
        await proximaCompensacao(c, saga, saga.compensar.slice(1));
        return;
      }

      // Ex.: resposta que chegou depois do timeout. O estado da saga não muda.
      await registrar(c, saga.id, 'ignorada', `resposta ${evento.tipo.replace('saga.resposta.', '')} fora de hora (saga ${saga.estado}, passo ${saga.passo})`);
      log.info({ sagaId: saga.id, tipo: evento.tipo, estado: saga.estado, passo: saga.passo }, 'resposta fora de hora ignorada');
    });
  }

  // Varre sagas com prazo vencido. SKIP LOCKED: com várias réplicas, cada saga é tratada por uma só.
  async function verificarPrazos(): Promise<void> {
    await emTransacao(async (c) => {
      const { rows } = await c.query<LinhaSaga>(
        `SELECT * FROM sagas WHERE estado IN ('EM_ANDAMENTO', 'COMPENSANDO') AND prazo_em < now()
          ORDER BY prazo_em LIMIT 20 FOR UPDATE SKIP LOCKED`,
      );
      for (const saga of rows) {
        if (saga.passo === 'fim') continue;
        const passo = PASSOS[saga.passo];
        if (saga.estado === 'EM_ANDAMENTO') {
          await registrar(c, saga.id, 'timeout', `${passo.transacao} sem resposta em ${timeoutMs / 1000}s`);
          await iniciarCompensacao(c, saga, `timeout em ${passo.transacao} (${passo.descricao})`, true);
        } else if (saga.tentativas + 1 >= config.saga.maxTentativas) {
          await c.query(`UPDATE sagas SET estado = 'FALHOU', prazo_em = NULL, atualizado_em = now() WHERE id = $1`, [saga.id]);
          await registrar(c, saga.id, 'FALHOU', `${passo.compensacao} não confirmada após ${config.saga.maxTentativas} tentativas; requer intervenção`);
          log.error({ sagaId: saga.id, passo: saga.passo }, 'saga FALHOU: compensação não confirmada');
        } else {
          // Compensações são re-tentadas até serem confirmadas (são idempotentes no participante).
          await passo.compensar(c, saga.id, saga.dados);
          await c.query(
            `UPDATE sagas SET tentativas = tentativas + 1, prazo_em = ${prazo(timeoutMs)}, atualizado_em = now() WHERE id = $1`,
            [saga.id],
          );
          await registrar(c, saga.id, passo.compensacao, `sem confirmação; comando reenviado (tentativa ${saga.tentativas + 2})`);
        }
      }
    });
  }

  let timer: NodeJS.Timeout | null = null;
  return {
    iniciar,
    aoResponder,
    iniciarMonitorDePrazos(intervaloMs = 1000) {
      const agendar = () => {
        timer = setTimeout(() => {
          verificarPrazos()
            .catch((erro) => log.warn({ err: (erro as Error).message }, 'falha ao verificar prazos das sagas'))
            .finally(agendar);
        }, intervaloMs);
      };
      agendar();
    },
    parar() {
      if (timer) clearTimeout(timer);
    },
  };
}

// Consulta para acompanhar a saga de uma mobilização (estado + linha do tempo).
export async function consultarSaga(mobilizacaoId: string) {
  const { rows } = await pool.query(
    `SELECT id AS "sagaId", mobilizacao_id AS "mobilizacaoId", estado, passo, concluidos, compensar AS "compensacoesPendentes",
            motivo, prazo_em AS "prazoEm", criado_em AS "criadoEm", atualizado_em AS "atualizadoEm"
       FROM sagas WHERE mobilizacao_id = $1 ORDER BY criado_em DESC LIMIT 1`,
    [mobilizacaoId],
  );
  if (!rows[0]) return null;
  const historico = await pool.query(
    `SELECT ocorrido_em AS "em", etapa, descricao FROM saga_historico WHERE saga_id = $1 ORDER BY id`,
    [rows[0].sagaId],
  );
  return { ...rows[0], historico: historico.rows };
}

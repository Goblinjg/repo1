// CQRS do painel da comunidade.
//
// Escrita: tabelas normalizadas `comunidades` e `membros` (rotas.ts), que gravam os eventos na
// outbox na mesma transação. Leitura: `painel_comunidade`, um documento JSON pronto por
// comunidade, atualizado de forma ASSÍNCRONA pela projeção ao consumir os eventos da fila
// comunidades.painel. A consulta lê só esse documento: uma query, sem fan-out.
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { Evento } from '../broker.js';
import { pool } from '../db.js';
import { emTransacao, primeiraVez } from '../outbox/relay.js';

export interface MembroPainel {
  doadorId: string;
  nome: string | null;
  papel: 'admin' | 'membro';
}

export interface PainelComunidade {
  comunidadeId: string;
  nome: string;
  descricao: string | null;
  cidade: string;
  uf: string;
  totalMembros: number;
  membros: MembroPainel[];
  totalMobilizacoes: number;
  proximasMobilizacoes: { id: string; titulo: string; dataHora: string }[];
}

export interface Projecao {
  aplicar(evento: Evento): Promise<void>;
}

export interface ConsultaPainel {
  obter(comunidadeId: string): Promise<(PainelComunidade & { versao: number; atualizadoEm: string }) | null>;
}

interface DadosEvento {
  comunidadeId?: string;
  doadorId?: string;
  nome?: string;
  mobilizacaoId?: string;
  titulo?: string;
  dataHora?: string;
  estado?: string;
}

// Monta o documento a partir do modelo de escrita + réplicas locais e grava a nova versão.
// É determinístico: aplicar o mesmo evento duas vezes gera o mesmo documento (idempotente),
// e rodar para todas as comunidades reconstrói a projeção do zero.
export async function reconstruirPainel(c: pg.PoolClient, comunidadeId: string): Promise<void> {
  const { rows } = await c.query<{ documento: PainelComunidade | null }>(
    `SELECT jsonb_build_object(
              'comunidadeId', co.id, 'nome', co.nome, 'descricao', co.descricao, 'cidade', co.cidade, 'uf', co.uf,
              'totalMembros', (SELECT count(*) FROM membros m WHERE m.comunidade_id = co.id),
              'membros', COALESCE((
                  SELECT jsonb_agg(jsonb_build_object('doadorId', m.doador_id, 'nome', d.nome, 'papel', m.papel)
                                   ORDER BY m.papel, m.entrou_em)
                    FROM membros m LEFT JOIN doadores_nomes d ON d.doador_id = m.doador_id
                   WHERE m.comunidade_id = co.id), '[]'::jsonb),
              'totalMobilizacoes', (SELECT count(*) FROM mobilizacoes_resumo r
                                     WHERE r.comunidade_id = co.id AND r.estado = 'CONFIRMADA'),
              'proximasMobilizacoes', COALESCE((
                  SELECT jsonb_agg(jsonb_build_object('id', r.id, 'titulo', r.titulo, 'dataHora', r.data_hora) ORDER BY r.data_hora)
                    FROM (SELECT * FROM mobilizacoes_resumo r
                           WHERE r.comunidade_id = co.id AND r.estado = 'CONFIRMADA' AND r.data_hora >= now()
                           ORDER BY r.data_hora LIMIT 10) r), '[]'::jsonb)
            ) AS documento
       FROM comunidades co WHERE co.id = $1`,
    [comunidadeId],
  );
  if (!rows[0]) {
    await c.query('DELETE FROM painel_comunidade WHERE comunidade_id = $1', [comunidadeId]);
    return;
  }
  await c.query(
    `INSERT INTO painel_comunidade (comunidade_id, documento) VALUES ($1, $2)
     ON CONFLICT (comunidade_id) DO UPDATE
       SET documento = EXCLUDED.documento, versao = painel_comunidade.versao + 1, atualizado_em = now()`,
    [comunidadeId, JSON.stringify(rows[0].documento)],
  );
}

export function criarProjecao(log: FastifyBaseLogger): Projecao {
  return {
    async aplicar(evento: Evento): Promise<void> {
      const d = evento.dados as DadosEvento;
      await emTransacao(async (c) => {
        if (!(await primeiraVez(c, evento, 'painel'))) {
          log.info({ eventoId: evento.id }, 'projeção: evento duplicado ignorado');
          return;
        }
        let afetadas: string[] = d.comunidadeId ? [d.comunidadeId] : [];

        switch (evento.tipo) {
          case 'mobilizacao.criada':
          case 'mobilizacao.sincronizada':
            await c.query(
              `INSERT INTO mobilizacoes_resumo (id, comunidade_id, titulo, data_hora, estado) VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (id) DO UPDATE SET titulo = EXCLUDED.titulo, data_hora = EXCLUDED.data_hora,
                                              estado = EXCLUDED.estado, atualizado_em = now()`,
              [d.mobilizacaoId, d.comunidadeId, d.titulo ?? '(sem título)', d.dataHora, d.estado ?? 'CONFIRMADA'],
            );
            break;
          case 'mobilizacao.cancelada':
            await c.query(`UPDATE mobilizacoes_resumo SET estado = 'CANCELADA', atualizado_em = now() WHERE id = $1`, [d.mobilizacaoId]);
            break;
          case 'doador.cadastrado':
          case 'doador.atualizado': {
            await c.query(
              `INSERT INTO doadores_nomes (doador_id, nome) VALUES ($1, $2)
               ON CONFLICT (doador_id) DO UPDATE SET nome = EXCLUDED.nome, atualizado_em = now()`,
              [d.doadorId, d.nome],
            );
            const r = await c.query<{ comunidade_id: string }>('SELECT comunidade_id FROM membros WHERE doador_id = $1', [d.doadorId]);
            afetadas = r.rows.map((x) => x.comunidade_id);
            break;
          }
          // comunidade.criada, membro.entrou e membro.saiu: o documento é remontado a partir do modelo de escrita
        }

        for (const id of afetadas) await reconstruirPainel(c, id);
        const atraso = Date.now() - new Date(evento.ocorridoEm).getTime();
        log.info({ eventoId: evento.id, tipo: evento.tipo, comunidades: afetadas.length, defasagemMs: atraso }, 'projeção do painel atualizada');
      });
    },
  };
}

export const consultaPainel: ConsultaPainel = {
  async obter(comunidadeId) {
    const { rows } = await pool.query(
      `SELECT documento || jsonb_build_object('versao', versao, 'atualizadoEm', atualizado_em) AS painel
         FROM painel_comunidade WHERE comunidade_id = $1`,
      [comunidadeId],
    );
    return rows[0]?.painel ?? null;
  },
};

// Recuperação: (re)constrói a projeção das comunidades que não têm documento (ou de todas).
export async function reconstruirProjecao(todas = false): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    todas
      ? 'SELECT id FROM comunidades'
      : 'SELECT c.id FROM comunidades c WHERE NOT EXISTS (SELECT 1 FROM painel_comunidade p WHERE p.comunidade_id = c.id)',
  );
  for (const { id } of rows) await emTransacao((c) => reconstruirPainel(c, id));
  return rows.length;
}

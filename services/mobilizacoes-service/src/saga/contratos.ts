// Contratos da SAGA orquestrada "criar mobilização confirmada".
import type pg from 'pg';

export type EstadoSaga = 'INICIADA' | 'EM_ANDAMENTO' | 'CONCLUIDA' | 'COMPENSANDO' | 'COMPENSADA' | 'FALHOU';

// Dados que a saga carrega do início ao fim (coluna sagas.dados).
export interface ContextoSaga {
  mobilizacaoId: string;
  comunidadeId: string;
  criadorId: string;
  dataHora: string;
  hemocentroId: string | null;
}

export type NomePasso = 'data' | 'janela';

// Um passo remoto: executar e compensar GRAVAM o comando na outbox, dentro da transação
// do orquestrador. O relay publica; a resposta chega depois pela fila saga.mobilizacoes.respostas.
export interface PassoSaga<C> {
  nome: NomePasso;
  descricao: string;
  executar(cliente: pg.PoolClient, sagaId: string, contexto: C): Promise<void>;
  compensar(cliente: pg.PoolClient, sagaId: string, contexto: C): Promise<void>;
  // tipos de resposta que o participante envia
  respostas: { sucesso: string; recusa: string; compensado: string };
}

export interface OrquestradorSaga<C> {
  // T1: chamado dentro da transação que cria a mobilização PENDENTE
  iniciar(cliente: pg.PoolClient, contexto: C): Promise<{ sagaId: string; estado: EstadoSaga }>;
}

// Formato das respostas enviadas pelos participantes.
export interface RespostaSaga {
  sagaId: string;
  motivo?: string;
}

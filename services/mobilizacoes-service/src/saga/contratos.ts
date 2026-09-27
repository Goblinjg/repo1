// Parte 4: contratos da SAGA orquestrada. Ainda sem implementação.
export type EstadoSaga = 'INICIADA' | 'EM_ANDAMENTO' | 'CONCLUIDA' | 'COMPENSANDO' | 'COMPENSADA' | 'FALHOU';

export interface PassoSaga<C> {
  nome: string;
  executar(contexto: C): Promise<void>;
  compensar(contexto: C): Promise<void>;
}

export interface OrquestradorSaga<C> {
  iniciar(contexto: C): Promise<{ sagaId: string; estado: EstadoSaga }>;
}

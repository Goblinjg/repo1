// Parte 4: relay do Transactional Outbox (lê `outbox` com publicado_em IS NULL e publica).
// A tabela já existe; hoje ela só recebe eventos cuja publicação direta falhou.
export interface OutboxRelay {
  iniciar(intervaloMs: number): void;
  parar(): Promise<void>;
}

// Parte 4: contrato do modelo de leitura (CQRS). Ainda sem implementação.
import type { Evento } from '../broker.js';

export interface PainelComunidade {
  comunidadeId: string;
  nome: string;
  totalMembros: number;
  proximasMobilizacoes: { id: string; titulo: string; dataHora: string }[];
}

export interface Projecao {
  aplicar(evento: Evento): Promise<void>;
}

export interface ConsultaPainel {
  obter(comunidadeId: string): Promise<PainelComunidade | null>;
}

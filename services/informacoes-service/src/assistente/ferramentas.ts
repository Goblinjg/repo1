// Ferramentas (tools do LangChain) que deixam o modelo consultar DADOS REAIS do sistema:
// os hemocentros e as janelas de coleta reservadas pela SAGA, no banco do informacoes-service.
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { pool } from '../db.js';

const normalizar = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

interface Hemocentro {
  id: string;
  nome: string;
  cidade: string;
  uf: string;
  endereco: string;
  horarios: string | null;
  capacidade_diaria: number;
}

async function hemocentrosDaCidade(cidade: string): Promise<Hemocentro[]> {
  const { rows } = await pool.query<Hemocentro>('SELECT id, nome, cidade, uf, endereco, horarios, capacidade_diaria FROM hemocentros ORDER BY nome');
  const alvo = normalizar(cidade);
  return rows.filter((h) => normalizar(h.cidade).includes(alvo) || alvo.includes(normalizar(h.cidade)));
}

export async function cidadesComHemocentro(): Promise<string[]> {
  const { rows } = await pool.query<{ cidade: string }>('SELECT DISTINCT cidade FROM hemocentros');
  return rows.map((r) => r.cidade);
}

export const buscarHemocentros = tool(
  async ({ cidade }) => {
    const lista = await hemocentrosDaCidade(cidade);
    if (!lista.length) return `Nenhum hemocentro cadastrado no 4Life para "${cidade}".`;
    return lista
      .map((h) => `- ${h.nome} (${h.cidade}/${h.uf}): ${h.endereco}; horário: ${h.horarios ?? 'não informado'}; até ${h.capacidade_diaria} mobilização(ões) por dia`)
      .join('\n');
  },
  {
    name: 'buscar_hemocentros',
    description:
      'Consulta no banco do 4Life os hemocentros de uma cidade: nome, endereço, horário de funcionamento e capacidade diária de mobilizações. Use quando perguntarem onde doar ou o endereço/horário de um hemocentro.',
    schema: z.object({ cidade: z.string().describe('nome da cidade, ex.: Lavras') }),
  },
);

export const verificarDisponibilidade = tool(
  async ({ cidade, data }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return `Data inválida "${data}"; use AAAA-MM-DD.`;
    const lista = await hemocentrosDaCidade(cidade);
    if (!lista.length) return `Nenhum hemocentro cadastrado no 4Life para "${cidade}".`;
    const linhas = [];
    for (const h of lista) {
      const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM reservas_hemocentro WHERE hemocentro_id = $1 AND data = $2', [h.id, data]);
      const livres = Math.max(h.capacidade_diaria - rows[0].n, 0);
      const dia = data.split('-').reverse().join('/');
      // texto explícito (SEM VAGA / HÁ VAGA): um modelo pequeno interpreta mal "0 de 1"
      linhas.push(
        livres > 0
          ? `- ${h.nome} em ${dia}: HÁ VAGA. ${livres} de ${h.capacidade_diaria} janela(s) de coleta livre(s) para mobilização.`
          : `- ${h.nome} em ${dia}: SEM VAGA. Todas as ${h.capacidade_diaria} janela(s) de coleta já estão reservadas; escolha outra data.`,
      );
    }
    return linhas.join('\n');
  },
  {
    name: 'verificar_disponibilidade',
    description:
      'Verifica no banco do 4Life quantas janelas de coleta para mobilizações ainda estão livres nos hemocentros de uma cidade em uma data. Use quando perguntarem se há vaga/disponibilidade para uma mobilização numa data.',
    schema: z.object({
      cidade: z.string().describe('nome da cidade, ex.: Lavras'),
      data: z.string().describe('data no formato AAAA-MM-DD'),
    }),
  },
);

export const FERRAMENTAS = [buscarHemocentros, verificarDisponibilidade];

// Base vetorial em PostgreSQL + pgvector, no banco do próprio informacoes-service.
// Implementa o contrato VectorStore do LangChain, então funciona com .asRetriever() e
// similaritySearchWithScore como qualquer vector store da biblioteca.
import { Document, type DocumentInterface } from '@langchain/core/documents';
import { Embeddings, type EmbeddingsInterface } from '@langchain/core/embeddings';
import { VectorStore } from '@langchain/core/vectorstores';
import type pg from 'pg';
import { pool } from '../db.js';

const vetorSql = (v: number[]) => `[${v.join(',')}]`;

export class PgVectorStore extends VectorStore {
  declare FilterType: Record<string, never>;

  constructor(embeddings: EmbeddingsInterface, private readonly cliente: pg.Pool | pg.PoolClient = pool) {
    super(embeddings, {});
  }

  _vectorstoreType(): string {
    return 'pgvector';
  }

  async addDocuments(documentos: DocumentInterface[]): Promise<string[]> {
    const vetores = await this.embeddings.embedDocuments(documentos.map((d) => d.pageContent));
    return this.addVectors(vetores, documentos);
  }

  async addVectors(vetores: number[][], documentos: DocumentInterface[]): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < documentos.length; i++) {
      const { rows } = await this.cliente.query<{ id: string }>(
        'INSERT INTO rag_trechos (conteudo, metadados, embedding) VALUES ($1, $2, $3::vector) RETURNING id',
        [documentos[i].pageContent, JSON.stringify(documentos[i].metadata ?? {}), vetorSql(vetores[i])],
      );
      ids.push(rows[0].id);
    }
    return ids;
  }

  // Similaridade de cosseno (1 = idêntico). Usa o índice HNSW.
  async similaritySearchVectorWithScore(consulta: number[], k: number): Promise<[DocumentInterface, number][]> {
    const { rows } = await this.cliente.query<{ conteudo: string; metadados: Record<string, unknown>; similaridade: number }>(
      `SELECT conteudo, metadados, 1 - (embedding <=> $1::vector) AS similaridade
         FROM rag_trechos ORDER BY embedding <=> $1::vector LIMIT $2`,
      [vetorSql(consulta), k],
    );
    return rows.map((r) => [new Document({ pageContent: r.conteudo, metadata: r.metadados }), Number(r.similaridade)]);
  }

  // Busca textual (full-text search em português), sem depender do modelo de embeddings.
  // Usada pelo fallback quando o Ollama está fora do ar. Termos combinados com OU.
  async buscaTextual(texto: string, k: number): Promise<[DocumentInterface, number][]> {
    const { rows } = await this.cliente.query<{ conteudo: string; metadados: Record<string, unknown>; rank: number }>(
      `WITH q AS (SELECT replace(plainto_tsquery('portuguese', $1)::text, '&', '|')::tsquery AS consulta)
       SELECT conteudo, metadados, ts_rank(busca, q.consulta) AS rank
         FROM rag_trechos, q
        WHERE q.consulta::text <> '' AND busca @@ q.consulta
        ORDER BY rank DESC LIMIT $2`,
      [texto, k],
    );
    return rows.map((r) => [new Document({ pageContent: r.conteudo, metadata: r.metadados }), Number(r.rank)]);
  }
}

// Embeddings com:
//  - prefixos de tarefa quando o modelo pede (nomic-embed-text: search_query / search_document);
//  - cache em memória das consultas: a pergunta é vetorizada uma vez para o cache semântico e
//    reaproveitada pela recuperação;
//  - proteção (timeout + retry + circuit breaker) injetada por quem cria.
export class EmbeddingsDoAssistente extends Embeddings {
  private readonly cache = new Map<string, number[]>();

  constructor(
    private readonly base: EmbeddingsInterface,
    private readonly proteger: <T>(rotulo: string, fn: () => Promise<T>) => Promise<T>,
    modelo: string,
  ) {
    super({});
    const nomic = modelo.startsWith('nomic');
    this.prefixoConsulta = nomic ? 'search_query: ' : '';
    this.prefixoDocumento = nomic ? 'search_document: ' : '';
  }

  private readonly prefixoConsulta: string;
  private readonly prefixoDocumento: string;

  async embedDocuments(textos: string[]): Promise<number[][]> {
    return this.proteger('embeddings:documentos', () => this.base.embedDocuments(textos.map((t) => this.prefixoDocumento + t)));
  }

  async embedQuery(texto: string): Promise<number[]> {
    const guardado = this.cache.get(texto);
    if (guardado) return guardado;
    const vetor = await this.proteger('embeddings:consulta', () => this.base.embedQuery(this.prefixoConsulta + texto));
    this.cache.set(texto, vetor);
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return vetor;
  }
}

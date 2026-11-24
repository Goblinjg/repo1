// Pipeline de ingestão do RAG: carregar → dividir em trechos → gerar embeddings → gravar no pgvector.
// Fontes: os documentos em `conhecimento/` (base própria do 4Life) + conteúdos e FAQ do banco do serviço.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Document } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db.js';
import { emTransacao } from '../outbox/relay.js';
import { PgVectorStore } from './vetores.js';

export interface EstadoIngestao {
  status: 'pendente' | 'ingerindo' | 'pronta' | 'erro';
  documentos?: number;
  trechos?: number;
  hash?: string;
  erro?: string;
  em?: string;
}

export const estadoIngestao: EstadoIngestao = { status: 'pendente' };

// Trechos pequenos (≈ uma seção "##" cada): com um modelo de 0,5B, misturar dois assuntos no
// mesmo trecho (ex.: prazo da gripe e prazo da tatuagem) faz o modelo trocar os números.
const divisor = RecursiveCharacterTextSplitter.fromLanguage('markdown', { chunkSize: 450, chunkOverlap: 40 });
const LOCK_INGESTAO = 4105; // advisory lock: só uma réplica ingere por vez

async function carregarDocumentos(): Promise<Document[]> {
  const trechos: Document[] = [];
  const dir = path.resolve(process.cwd(), config.assistente.dirConhecimento);
  for (const arquivo of (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()) {
    const texto = await readFile(path.join(dir, arquivo), 'utf8');
    const titulo = texto.match(/^# (.+)$/m)?.[1] ?? arquivo;
    // cada trecho leva o título do documento: o trecho isolado continua tendo contexto
    trechos.push(...(await divisor.createDocuments([texto], [{ fonte: `conhecimento/${arquivo}`, titulo }], { chunkHeader: `${titulo}\n\n` })));
  }
  const conteudos = await pool.query<{ slug: string; titulo: string; corpo: string }>('SELECT slug, titulo, corpo FROM conteudos ORDER BY slug');
  for (const c of conteudos.rows) {
    trechos.push(new Document({ pageContent: `${c.titulo}\n\n${c.corpo}`, metadata: { fonte: `conteudos/${c.slug}`, titulo: c.titulo } }));
  }
  const faq = await pool.query<{ pergunta: string; resposta: string }>('SELECT pergunta, resposta FROM faq ORDER BY ordem');
  for (const f of faq.rows) {
    trechos.push(new Document({ pageContent: `Pergunta frequente: ${f.pergunta}\nResposta: ${f.resposta}`, metadata: { fonte: 'faq', titulo: f.pergunta } }));
  }
  return trechos;
}

// Idempotente: se o hash da base (conteúdo + modelo de embeddings) já foi ingerido, não faz nada.
export async function ingerir(embeddings: EmbeddingsInterface, log: FastifyBaseLogger, forcar = false): Promise<EstadoIngestao> {
  const trechos = await carregarDocumentos();
  const hash = createHash('sha256')
    .update(config.assistente.modeloEmbeddings)
    .update(trechos.map((t) => t.pageContent).join('\u0000'))
    .digest('hex')
    .slice(0, 16);
  const documentos = new Set(trechos.map((t) => t.metadata.fonte)).size;

  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_INGESTAO]);
    const ja = await lock.query<{ ingerido_em: Date }>('SELECT ingerido_em FROM rag_ingestao WHERE hash = $1', [hash]);
    if (ja.rows[0] && !forcar) {
      Object.assign(estadoIngestao, { status: 'pronta', documentos, trechos: trechos.length, hash, erro: undefined, em: ja.rows[0].ingerido_em.toISOString() });
      log.info({ hash, trechos: trechos.length }, 'RAG: base de conhecimento já ingerida');
      return estadoIngestao;
    }

    Object.assign(estadoIngestao, { status: 'ingerindo', erro: undefined });
    const inicio = Date.now();
    // embeddings em lotes pequenos: cada chamada fica bem abaixo do timeout
    const vetores: number[][] = [];
    for (let i = 0; i < trechos.length; i += 8) {
      vetores.push(...(await embeddings.embedDocuments(trechos.slice(i, i + 8).map((t) => t.pageContent))));
    }
    await emTransacao(async (c) => {
      await c.query('DELETE FROM rag_trechos');
      await new PgVectorStore(embeddings, c).addVectors(vetores, trechos);
      await c.query('DELETE FROM rag_ingestao');
      await c.query('INSERT INTO rag_ingestao (hash, documentos, trechos) VALUES ($1, $2, $3)', [hash, documentos, trechos.length]);
      await c.query('DELETE FROM assistente_cache'); // respostas antigas podem não valer para a base nova
    });
    Object.assign(estadoIngestao, { status: 'pronta', documentos, trechos: trechos.length, hash, em: new Date().toISOString() });
    log.info({ hash, documentos, trechos: trechos.length, ms: Date.now() - inicio }, 'RAG: ingestão concluída');
    return estadoIngestao;
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_INGESTAO]).catch(() => {});
    lock.release();
  }
}

// No boot o Ollama pode ainda estar baixando os modelos: tenta até conseguir, sem travar o serviço.
export async function ingerirComRetentativas(embeddings: EmbeddingsInterface, log: FastifyBaseLogger): Promise<void> {
  for (let tentativa = 1; ; tentativa++) {
    try {
      await ingerir(embeddings, log);
      return;
    } catch (erro) {
      const espera = Math.min(5000 * tentativa, 60_000);
      Object.assign(estadoIngestao, { status: 'erro', erro: (erro as Error).message });
      log.warn({ err: (erro as Error).message, esperaMs: espera }, 'RAG: ingestão falhou; nova tentativa');
      await new Promise((r) => setTimeout(r, espera));
    }
  }
}

# Avaliação do RAG — com e sem recuperação

> Requisito 6.2: *ao menos 5 perguntas de teste com análise das respostas, comparando com e sem recuperação.*
> Aqui são **8 perguntas**, reproduzíveis com `./scripts/avaliar-rag.sh`.

## Método

| Item | Valor |
|---|---|
| Modelo de linguagem | `qwen2.5:0.5b` (Ollama, CPU, temperatura 0) |
| Modelo de embeddings | `bge-m3` (1024 dimensões, multilíngue) |
| Base de conhecimento | 10 documentos em [`services/informacoes-service/conhecimento/`](../../services/informacoes-service/conhecimento/) + 9 conteúdos e 5 perguntas do FAQ do banco → **41 trechos** |
| Recuperação | k = 3 trechos por similaridade de cosseno (pgvector, índice HNSW) |
| Perguntas | [`perguntas-avaliacao.json`](perguntas-avaliacao.json): 4 sobre doação em geral, 3 sobre regras **próprias do 4Life** (que o modelo não tem como saber sozinho) e 1 de conhecimento geral |
| COM RAG | `usarRag: true`: a resposta usa os trechos recuperados (e as tools, se o modelo pedir) |
| SEM RAG | `usarRag: false`: **mesmo modelo, mesmo prompt de sistema**, sem os trechos (linha de base) |
| Cache | desligado (`usarCache: false`), para cada resposta vir do modelo |
| Critério automático | a resposta precisa conter os **fatos-chave** esperados (regex) e **nenhum padrão proibido**, ou seja, nada que contradiga o esperado (ex.: "Sim" quando o certo é "não") |

Os resultados brutos (respostas, fontes com similaridade e tempos) ficam em
[`avaliacao-rag-resultados.json`](avaliacao-rag-resultados.json) (Docker Compose) e
[`avaliacao-rag-resultados-k8s.json`](avaliacao-rag-resultados-k8s.json) (Kubernetes).

## Resultado

| Ambiente | COM RAG | SEM RAG | Tempo médio COM RAG |
|---|---|---|---|
| Docker Compose | **8/8** | 0/8 | 3,1 s |
| Kubernetes (kind) | **7/8** | 0/8 | 5,6 s |

A tabela abaixo traz as respostas da rodada no **Compose**. As diferenças da rodada no Kubernetes
estão em [Variação entre ambientes](#variação-entre-ambientes).

| # | Pergunta | Esperado | COM RAG | SEM RAG | Trechos recuperados (similaridade) |
|---|---|---|---|---|---|
| 1 | Fiz uma tatuagem, quanto tempo preciso esperar para doar sangue? | 12 meses | ✔ "12 meses." | ✘ "…esperar 2-3 semanas após o procedimento." | FAQ tatuagem (0,699); impedimentos temporários (0,673); mitos (0,649) |
| 2 | Qual o intervalo mínimo entre doações para mulheres? | 90 dias | ✔ "…é de 90 dias (3 meses)." | ✘ "…é de 5 dias." | intervalo entre doações (0,726); FAQ (0,698); intervalo (0,624) |
| 3 | Quem pode criar uma mobilização no 4Life? | só administradores da comunidade | ✔ "Somente administradores da comunidade podem criar mobilizações." | ✘ "…qualquer grupo ou organização possa criar…" | 4Life mobilizações (0,732; 0,628; 0,621) |
| 4 | No 4Life, o que acontece com a mobilização se o hemocentro não tiver capacidade no dia? | reserva recusada, mobilização CANCELADA | ✔ "O hemocentro sem capacidade na data escolhida cancela a mobilização. Se houver outra data disponível, a comunidade pode criar uma nova…" | ✘ "…as doações de sangue podem ser suspensas ou canceladas." | 4Life mobilizações (0,787; 0,680; 0,668) |
| 5 | Uma comunidade do 4Life pode ter duas mobilizações no mesmo dia? | não (no máximo uma por dia) | ✔ "não" | ✘ "Sim, uma comunidade do 4Life pode ter duas mobilizações em um mesmo dia." | 4Life mobilizações (0,796; 0,692; 0,607) |
| 6 | Preciso estar em jejum para doar sangue? | não; refeição leve | ✔ "Não. Pelo contrário: alimente-se de forma leve antes de doar." | ✘ "Sim, é recomendável que você esteja em jejum…" | FAQ jejum (0,680); requisitos básicos (0,677; 0,601) |
| 7 | Depois de uma gripe, quanto tempo devo esperar para doar? | 7 dias após o fim dos sintomas | ✔ "7 dias após o fim dos sintomas." | ✘ "…é recomendado que os pacientes sejam atendidos imediatamente após o diagnóstico…" | impedimentos temporários (0,652; 0,630); cuidados depois (0,603) |
| 8 | Qual tipo sanguíneo é considerado doador universal? | O negativo (O-) | ✔* "Odo negativo." | ✘ "O sanguíneo doador universal é o A." | tipos sanguíneos (0,684; 0,646; 0,619) |

Tempo médio: ~3,1 s por resposta COM RAG (2 chamadas ao LLM + embedding da pergunta) e ~2,2 s SEM RAG
(CPU, sem GPU).

## Análise

**1. Sem recuperação o modelo erra tudo, e erra com confiança.** Um modelo de 0,5 B parâmetros não
tem conhecimento confiável sobre critérios de doação no Brasil: inventa prazos ("2-3 semanas" para
tatuagem, "5 dias" entre doações de mulheres) e chega a dar orientação **perigosa** ("é recomendável
estar em jejum"). Nas perguntas sobre o 4Life (3, 4, 5) ele não tem como saber as regras da
plataforma e responde algo genérico ou o contrário da regra ("qualquer grupo pode criar",
"pode ter duas no mesmo dia"). É o cenário em que o RAG mais agrega: **conhecimento privado do
domínio**.

**2. Com recuperação, o trecho certo chega ao modelo em todas as perguntas.** Em todas as 8, o
documento que contém a resposta está entre os 3 trechos recuperados, quase sempre em 1º lugar. As
respostas COM RAG repetem números e regras do texto (12 meses, 90 dias, 7 dias, "somente
administradores").

**3. Limitações observadas (o que o RAG não resolve):**

- **Qualidade da geração de um modelo muito pequeno.** A resposta 8 contou como correta, mas saiu
  truncada ("Odo negativo"): o modelo leu o trecho certo e escreveu mal. A resposta 5 ("não") está
  correta, mas seca demais. Um modelo maior (ex.: `qwen2.5:1.5b`) melhora a redação. O sistema já
  permite trocar o modelo com `LLM_MODELO`, sem mudar código.
- **Perguntas fora da base.** Em testes manuais, "Quem tem diabetes pode doar sangue?" (não coberta
  pela base) recebeu "Não." em vez de "não encontrei essa informação". O prompt pede para admitir
  quando não sabe, mas um modelo de 0,5 B nem sempre obedece. Mitigações possíveis: limiar mínimo de
  similaridade para responder, ou ampliar a base.
- **Risco de sobreajuste.** A base e o prompt foram ajustados olhando estas perguntas (ver abaixo).
  Os ajustes são práticas gerais (um assunto por trecho, preservar negações), não respostas
  específicas, mas o ideal seria validar com um segundo conjunto de perguntas que não foi usado
  nos ajustes.

## Variação entre ambientes

Mesmo com temperatura 0, o modelo não deu respostas idênticas no Compose e no Kubernetes. A
recuperação foi a mesma (mesmos trechos e similaridades); o que mudou foi a geração. A inferência em
CPU não é bit a bit determinística quando muda o número de threads e lotes (o pod do Ollama tem
limite de CPU diferente do container do Compose). Diferenças relevantes na rodada do Kubernetes:

| # | Compose | Kubernetes |
|---|---|---|
| 2 | ✔ "90 dias (3 meses)" | ✔ no critério automático, mas **parcialmente errada**: "3 meses, com a possibilidade de 3 doações **por mês**" (o certo é 3 por ano) |
| 4 | ✔ "…cancela a mobilização…" | ✔ "…cancela a mobilização… O motivo é fornecido." (com uma frase confusa no meio) |
| 5 | ✔ "não" | ✘ **"Sim, uma comunidade do 4Life pode ter duas mobilizações no mesmo dia."**, apesar de o trecho recuperado (similaridade 0,80) dizer o contrário |

Conclusões: (1) o ganho do RAG é robusto (0/8 → 7–8/8 nos dois ambientes); (2) com um modelo de
0,5 B, **negações** são o ponto mais frágil, porque o modelo às vezes contradiz o trecho; (3) o
critério automático por regex não pega erros "a mais" (como o "por mês" da pergunta 2), então a
leitura humana das respostas continua necessária, e é por isso que esta análise existe.

## Como chegamos aqui (iterações)

A avaliação foi usada para **melhorar o pipeline**, e cada rodada ensinou algo:

| Rodada | Mudança | COM RAG | Diagnóstico da rodada |
|---|---|---|---|
| 1 | `nomic-embed-text`, trechos de 700 caracteres, k = 4 | 4/8 | Respostas misturavam assuntos: o trecho com "tatuagem" também tinha "gripe: 7 dias", e o modelo trocava os prazos. A pergunta da gripe nem recuperou o trecho certo. |
| 2 | Trechos de 450 caracteres (≈ uma seção por trecho), k = 3, `numPredict`/`repeatPenalty`, prompt "copie números exatamente"; troca do embedding para `bge-m3` | 6/8 | Recuperação passou a acertar 8/8. Ainda havia geração contrária ao trecho na pergunta 4 ("passa para CONFIRMADA") e "não" sem explicação na 5. |
| 3 | Prompt: "se o trecho diz *não*, *somente* ou *no máximo*, preserve isso"; seção própria na base para "hemocentro sem capacidade" e "uma mobilização por dia" | 8/8 | Quando sucesso e falha estavam no mesmo trecho, o modelo copiava a frase errada. Separar os casos resolveu. |

### Escolha do modelo de embeddings

Medição feita sobre os mesmos 41 trechos e as 8 perguntas: posição do trecho que contém a resposta no
ranking da busca vetorial.

| Modelo | Dimensão | Acerto entre os 3 primeiros | MRR | Posições (perguntas 1 a 8) |
|---|---|---|---|---|
| `nomic-embed-text` | 768 | 6/8 | 0,62 | 5, 1, 1, 2, 2, 2, 4, 1 |
| `paraphrase-multilingual` | 768 | 7/8 | 0,64 | 2, 2, 1, 2, 4, 3, 1, 1 |
| **`bge-m3`** | 1024 | **8/8** | **0,81** | 2, 1, 1, 2, 2, 1, 1, 1 |

O `nomic-embed-text` foi treinado principalmente em inglês. Em português ele perdia trechos óbvios
(a pergunta da gripe não trazia o trecho da gripe). O `bge-m3` é multilíngue e venceu com folga;
o custo é o modelo maior (1,2 GB) e a ingestão mais lenta, o que não pesa para uma base deste tamanho.

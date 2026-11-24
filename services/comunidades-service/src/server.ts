import { criarApp, iniciar } from './app.js';
import { brokerConectado, conectarBroker } from './broker.js';
import { config } from './config.js';
import { criarProjecao, reconstruirProjecao } from './cqrs/modelo-leitura.js';
import { estado } from './db.js';
import { aoCriarMobilizacao } from './eventos.js';
import { criarRelay } from './outbox/relay.js';
import { rotas } from './rotas.js';
import { participanteSaga } from './saga.js';

// Sem broker, a API de comunidades continua útil: eventos ficam na outbox e o consumo é retomado ao reconectar.
const app = criarApp({ informativos: () => ({ broker: brokerConectado() ? 'ok' : 'desconectado' }) });
const relay = criarRelay(app.log);
await app.register(rotas);
await iniciar(app, () => relay.parar());

while (!estado.migrado) await new Promise((r) => setTimeout(r, 500));
// Comunidades que ainda não têm documento de leitura (ex.: dados de seed) ganham um agora.
app.log.info({ comunidades: await reconstruirProjecao() }, 'projeção do painel verificada');
relay.iniciar(config.outbox.intervaloMs);
void conectarBroker(app.log, [
  { fila: 'comunidades.mobilizacao-criada', handler: aoCriarMobilizacao(app.log) },
  { fila: 'comunidades.painel', handler: criarProjecao(app.log).aplicar, prefetch: 1 },
  { fila: 'saga.comunidades.comandos', handler: participanteSaga(app.log), prefetch: 1 },
]);

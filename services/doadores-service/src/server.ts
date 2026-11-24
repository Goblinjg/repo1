import { criarApp, iniciar } from './app.js';
import { brokerConectado, conectarBroker } from './broker.js';
import { config } from './config.js';
import { estado } from './db.js';
import { criarRelay } from './outbox/relay.js';
import { rotas } from './rotas.js';

// Só publica (via outbox): sem broker, cadastros continuam funcionando e os eventos saem depois.
const app = criarApp({ informativos: () => ({ broker: brokerConectado() ? 'ok' : 'desconectado' }) });
const relay = criarRelay(app.log);
await app.register(rotas);
await iniciar(app, () => relay.parar());

while (!estado.migrado) await new Promise((r) => setTimeout(r, 500));
relay.iniciar(config.outbox.intervaloMs);
void conectarBroker(app.log);

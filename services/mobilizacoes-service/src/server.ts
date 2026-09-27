import { criarApp, iniciar } from './app.js';
import { brokerConectado, conectarBroker } from './broker.js';
import { rotas } from './rotas.js';

const app = criarApp(() => ({ broker: brokerConectado() ? 'ok' : 'desconectado' }));
await app.register(rotas);
await iniciar(app);
void conectarBroker(app.log);

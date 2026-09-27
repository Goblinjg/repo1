import { criarApp, iniciar } from './app.js';
import { brokerConectado, conectarBroker } from './broker.js';
import { rotas } from './rotas.js';

// Quem publica eventos só está pronto se consegue publicar: sem broker, uma mobilização
// criada não chegaria às comunidades. (Na Parte 4 o outbox tira essa dependência.)
const app = criarApp({ obrigatorios: () => ({ broker: brokerConectado() }) });
await app.register(rotas);
await iniciar(app);
void conectarBroker(app.log);

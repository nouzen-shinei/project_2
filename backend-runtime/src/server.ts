import { createApp } from './app';
import { setupChatWebsocket } from './chatWebsocket';
import { setupChatInboxWebsocket } from './chatInboxWebsocket';

const app = createApp();
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => console.log('Backend runtime listening on', PORT));

setupChatWebsocket(server);
setupChatInboxWebsocket(server);

function graceful(sig: string) {
  console.log(`[shutdown] ${sig} received, closing server...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), Number(process.env.SHUTDOWN_TIMEOUT_MS || 10000));
}

['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => graceful(s)));


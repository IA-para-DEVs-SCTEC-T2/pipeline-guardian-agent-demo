import { createApp } from './app.js';
import { releaseInfo } from './release.js';

// Em produção quem define a porta é a plataforma (Railway, Docker); 3001 é o
// padrão de desenvolvimento.
const PORT = Number(process.env.PORT) || 3001;

const app = createApp();

app.listen(PORT, () => {
  const line = {
    level: 'info',
    time: new Date().toISOString(),
    ...releaseInfo(),
    message: `CopaFigurinhas ouvindo na porta ${PORT}`,
    port: PORT,
    frontendMounted: app.locals.frontend.mounted,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
});

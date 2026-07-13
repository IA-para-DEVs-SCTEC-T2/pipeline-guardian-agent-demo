import { createApp } from './app.js';

const PORT = Number(process.env.PORT) || 3001;

const app = createApp();

app.listen(PORT, () => {
  const line = {
    level: 'info',
    time: new Date().toISOString(),
    message: `CopaFigurinhas backend ouvindo na porta ${PORT}`,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
});

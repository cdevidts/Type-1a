import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

import { buildApp } from './app.js';
import { readConfig } from './config.js';

dotenv.config({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  quiet: true,
});

const config = readConfig();
const app = await buildApp(config);

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

import { generateKeyPairSync, randomBytes } from 'crypto';
const { privateKey } = generateKeyPairSync('ed25519');
process.env.DATABASE_URL ??= 'postgresql://intercept:intercept@127.0.0.1:5432/intercept_test';
process.env.API_KEY_PEPPER ??= randomBytes(32).toString('hex');
process.env.AUTHORIZATION_SIGNING_KEY ??= privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
process.env.APP_ORIGINS = 'https://app.test';
process.env.COOKIE_SECURE = '0';
process.env.LOG_LEVEL = 'silent';

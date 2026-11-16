import { login } from '../server/services/identity';
import { migrate } from '../server/db';
migrate().then(() => login({ did: 'did:privy:localtest', email: 'owner@local.test', wallet: null }, 'dev', null)).then((s) => { console.log(s.token); process.exit(0); });

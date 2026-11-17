import { Connection, PublicKey } from '@solana/web3.js';
import { inflateSync } from 'zlib';
(async () => {
  const pid = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
  const [base] = PublicKey.findProgramAddressSync([], pid);
  const addr = await PublicKey.createWithSeed(base, 'anchor:idl', pid);
  const info = await new Connection('https://api.mainnet-beta.solana.com').getAccountInfo(addr);
  const d = info!.data; const len = d.readUInt32LE(40);
  const idl = JSON.parse(inflateSync(d.subarray(44, 44 + len)).toString());
  for (const ix of idl.instructions) if (/route/i.test(ix.name)) console.log(ix.name, JSON.stringify(ix.args.map((a: any) => `${a.name}:${typeof a.type === 'string' ? a.type : JSON.stringify(a.type)}`)), ix.discriminator ? Buffer.from(ix.discriminator).toString('hex') : '');
})();

import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
const a = Keypair.generate().publicKey;
const m = new TransactionMessage({ payerKey: a, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: a, toPubkey: Keypair.generate().publicKey, lamports: 5e7 })] }).compileToV0Message();
process.stdout.write(Buffer.from(new VersionedTransaction(m).serialize()).toString('base64') + ' ' + a.toBase58());

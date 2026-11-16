/**
 * In-memory stand-in for the RPC methods Intercept uses. Transactions in the tests are real,
 * serialized web3.js transactions; only the cluster is simulated, with explicit pre/post states.
 */
import { AddressLookupTableAccount, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import { PROGRAMS, WSOL_MINT } from '../server/solana/programs';

export interface FakeAccount { lamports: number; owner: string; data: Buffer }

export function tokenAccountData(mint: string, owner: string, amount: bigint, delegate: string | null = null) {
  const b = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(b, 0);
  new PublicKey(owner).toBuffer().copy(b, 32);
  b.writeBigUInt64LE(amount, 64);
  if (delegate) { b.writeUInt32LE(1, 72); new PublicKey(delegate).toBuffer().copy(b, 76); }
  b[108] = 1; // initialized
  return b;
}
export function mintData(decimals: number) {
  const b = Buffer.alloc(82);
  b.writeBigUInt64LE(1_000_000_000_000n, 36);
  b[44] = decimals;
  b[45] = 1;
  return b;
}

export class FakeChain {
  slot = 300_000_000;
  pre = new Map<string, FakeAccount>();
  post = new Map<string, FakeAccount | null>();
  luts = new Map<string, PublicKey[]>();
  simError: unknown = null;
  failRpc: string | null = null;    // method name that throws
  inner: any[] = [];

  setAccount(addr: string, a: FakeAccount) { this.pre.set(addr, a); }
  setPost(addr: string, a: FakeAccount | null) { this.post.set(addr, a); }
  wallet(addr: string, lamports: number) { this.setAccount(addr, { lamports, owner: PROGRAMS.SYSTEM, data: Buffer.alloc(0) }); }
  token(addr: string, mint: string, owner: string, amount: bigint, program: string = PROGRAMS.TOKEN) { this.setAccount(addr, { lamports: 2_039_280, owner: program, data: tokenAccountData(mint, owner, amount) }); }
  mint(addr: string, decimals: number) { this.setAccount(addr, { lamports: 1_461_600, owner: PROGRAMS.TOKEN, data: mintData(decimals) }); }

  private guard(m: string) { if (this.failRpc === m) throw new Error('fetch failed: ECONNREFUSED'); }
  private info(a: FakeAccount | undefined | null) { return a ? { lamports: a.lamports, owner: new PublicKey(a.owner), data: a.data, executable: false, rentEpoch: 0 } : null; }

  connection(): any {
    return {
      getAddressLookupTable: async (k: PublicKey) => {
        this.guard('getAddressLookupTable');
        const addrs = this.luts.get(k.toBase58());
        return { context: { slot: this.slot }, value: addrs ? new AddressLookupTableAccount({ key: k, state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: addrs } }) : null };
      },
      getTokenAccountsByOwner: async (owner: PublicKey, f: { programId: PublicKey }) => {
        this.guard('getTokenAccountsByOwner');
        const value = [...this.pre].filter(([_k, a]) => a.owner === f.programId.toBase58() && a.data.length >= 165 && new PublicKey(a.data.subarray(32, 64)).equals(owner))
          .map(([k, a]) => ({ pubkey: new PublicKey(k), account: this.info(a) }));
        return { context: { slot: this.slot }, value };
      },
      getBalance: async (k: PublicKey) => { this.guard('getBalance'); return this.pre.get(k.toBase58())?.lamports ?? 0; },
      getMultipleAccountsInfo: async (ks: PublicKey[]) => { this.guard('getMultipleAccountsInfo'); return ks.map((k) => this.info(this.pre.get(k.toBase58()))); },
      getSlot: async () => { this.guard('getSlot'); return this.slot; },
      simulateTransaction: async (_tx: VersionedTransaction, cfg: any) => {
        this.guard('simulateTransaction');
        const accounts = (cfg.accounts?.addresses ?? []).map((a: string) => {
          const p = this.post.has(a) ? this.post.get(a) : this.pre.get(a);
          return p ? { lamports: p.lamports, owner: p.owner, data: [p.data.toString('base64'), 'base64'], executable: false, rentEpoch: 0 } : null;
        });
        return { context: { slot: this.slot }, value: { err: this.simError, logs: ['Program log: simulated'], unitsConsumed: 1234, accounts, innerInstructions: this.inner } };
      },
    };
  }
}

export function serialize(payer: PublicKey, ixs: TransactionInstruction[], luts: AddressLookupTableAccount[] = [], legacy = false) {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: ixs });
  const compiled = legacy ? msg.compileToLegacyMessage() : msg.compileToV0Message(luts);
  return Buffer.from(new VersionedTransaction(compiled).serialize()).toString('base64');
}

const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
export const ix = {
  solTransfer: (from: PublicKey, to: PublicKey, lamports: number) => SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports }),
  transferChecked: (src: PublicKey, mint: PublicKey, dst: PublicKey, owner: PublicKey, amount: bigint, decimals: number, program = PROGRAMS.TOKEN) =>
    new TransactionInstruction({ programId: new PublicKey(program), keys: [{ pubkey: src, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: dst, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([12]), u64(amount), Buffer.from([decimals])]) }),
  approve: (src: PublicKey, delegate: PublicKey, owner: PublicKey, amount: bigint) =>
    new TransactionInstruction({ programId: new PublicKey(PROGRAMS.TOKEN), keys: [{ pubkey: src, isSigner: false, isWritable: true }, { pubkey: delegate, isSigner: false, isWritable: false }, { pubkey: owner, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([4]), u64(amount)]) }),
  setAuthority: (account: PublicKey, current: PublicKey, next: PublicKey) =>
    new TransactionInstruction({ programId: new PublicKey(PROGRAMS.TOKEN), keys: [{ pubkey: account, isSigner: false, isWritable: true }, { pubkey: current, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([6, 2, 1]), next.toBuffer()]) }),
  unknown: (program: PublicKey, signer: PublicKey) => new TransactionInstruction({ programId: program, keys: [{ pubkey: signer, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) }),
  memo: (signer: PublicKey) => new TransactionInstruction({ programId: new PublicKey(PROGRAMS.MEMO), keys: [{ pubkey: signer, isSigner: true, isWritable: false }], data: Buffer.from('hello') }),
  jupiterRoute: (signer: PublicKey, accounts: PublicKey[], inAmount: bigint, quotedOut: bigint, slippageBps: number) => {
    const disc = require('crypto').createHash('sha256').update('global:route').digest().subarray(0, 8);
    const routePlan = Buffer.from([1, 0, 0, 0, 7, 100, 0, 1]); // opaque, variable-length
    const tail = Buffer.alloc(19); tail.writeBigUInt64LE(inAmount, 0); tail.writeBigUInt64LE(quotedOut, 8); tail.writeUInt16LE(slippageBps, 16); tail[18] = 0;
    return new TransactionInstruction({ programId: new PublicKey(PROGRAMS.JUPITER_V6), keys: [{ pubkey: signer, isSigner: true, isWritable: true }, ...accounts.map((a) => ({ pubkey: a, isSigner: false, isWritable: true }))], data: Buffer.concat([disc, routePlan, tail]) });
  },
};

export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export { WSOL_MINT };

/** Price API double: returns prices at the chain's slot (fresh) unless told otherwise. */
export function priceFetcher(chain: FakeChain, prices: Record<string, { usd: number; liquidity?: number; slotLag?: number }>, opts: { down?: boolean } = {}) {
  return async (url: string) => {
    if (opts.down) throw new Error('fetch failed');
    const ids = new URL(url).searchParams.get('ids')!.split(',');
    const body: any = {};
    for (const id of ids) { const p = prices[id]; if (p) body[id] = { usdPrice: p.usd, blockId: chain.slot - (p.slotLag ?? 2), liquidity: p.liquidity ?? 5e8, decimals: 6 }; }
    return { ok: true, status: 200, json: async () => body };
  };
}

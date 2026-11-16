import { Connection, PublicKey } from '@solana/web3.js';
import { PROGRAMS } from './programs';

export type Network = 'devnet' | 'mainnet-beta';

const conns = new Map<Network, Connection>();
export function connection(network: Network): Connection {
  let c = conns.get(network);
  if (!c) {
    const url = network === 'mainnet-beta'
      ? process.env.SOLANA_RPC_MAINNET ?? 'https://api.mainnet-beta.solana.com'
      : process.env.SOLANA_RPC_DEVNET ?? 'https://api.devnet.solana.com';
    // retries are handled here (classified), not by web3.js silently backing off
    c = new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true });
    conns.set(network, c);
  }
  return c;
}
/** test hook */
export function setConnection(network: Network, c: Connection) { conns.set(network, c); }

export class RpcError extends Error {
  constructor(public code: 'RPC_TIMEOUT' | 'RPC_RATE_LIMITED' | 'RPC_UNAVAILABLE' | 'RPC_ERROR', message: string) { super(message); }
}

export async function rpc<T>(what: string, fn: () => Promise<T>, timeoutMs = Number(process.env.RPC_TIMEOUT_MS ?? 8000)): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_r, rej) => { timer = setTimeout(() => rej(new RpcError('RPC_TIMEOUT', `${what}: RPC did not answer within ${timeoutMs} ms`)), timeoutMs); }),
    ]);
  } catch (e: any) {
    if (e instanceof RpcError) throw e;
    const m = String(e?.message ?? e);
    if (/429|too many requests|rate limit/i.test(m)) throw new RpcError('RPC_RATE_LIMITED', `${what}: RPC rate limited`);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket|502|503|504/i.test(m)) throw new RpcError('RPC_UNAVAILABLE', `${what}: RPC unavailable (${m.slice(0, 120)})`);
    throw new RpcError('RPC_ERROR', `${what}: ${m.slice(0, 200)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface TokenAccountState { address: string; program: string; mint: string; owner: string; amount: bigint; delegate: string | null; delegatedAmount: bigint }

/** Parses an SPL Token / Token-2022 token account (base layout, 165 bytes + extensions). */
export function parseTokenAccount(address: string, ownerProgram: string, data: Buffer): TokenAccountState | null {
  if (ownerProgram !== PROGRAMS.TOKEN && ownerProgram !== PROGRAMS.TOKEN_2022) return null;
  if (data.length < 165) return null;
  if (data.length > 165 && data[165] !== 2) return null; // Token-2022: account type 2 = Account (1 = Mint)
  const hasDelegate = data.readUInt32LE(72) === 1;
  return {
    address, program: ownerProgram,
    mint: new PublicKey(data.subarray(0, 32)).toBase58(),
    owner: new PublicKey(data.subarray(32, 64)).toBase58(),
    amount: data.readBigUInt64LE(64),
    delegate: hasDelegate ? new PublicKey(data.subarray(76, 108)).toBase58() : null,
    delegatedAmount: data.readBigUInt64LE(121),
  };
}

/** Mint decimals (byte 44 of the mint layout, both token programs). */
export function parseMintDecimals(ownerProgram: string, data: Buffer): number | null {
  if (ownerProgram !== PROGRAMS.TOKEN && ownerProgram !== PROGRAMS.TOKEN_2022) return null;
  if (data.length < 82) return null;
  if (data.length > 82 && data.length >= 166 && data[165] !== 1) return null;
  return data[44];
}

export async function walletTokenAccounts(conn: Connection, wallet: string): Promise<TokenAccountState[]> {
  const owner = new PublicKey(wallet);
  const out: TokenAccountState[] = [];
  for (const programId of [PROGRAMS.TOKEN, PROGRAMS.TOKEN_2022]) {
    const r = await rpc('getTokenAccountsByOwner', () => conn.getTokenAccountsByOwner(owner, { programId: new PublicKey(programId) }));
    for (const { pubkey, account } of r.value) {
      const t = parseTokenAccount(pubkey.toBase58(), account.owner.toBase58(), Buffer.from(account.data));
      if (t) out.push(t);
    }
  }
  return out;
}

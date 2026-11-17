/**
 * On-chain evidence. Robinhood Chain through JSON-RPC (endpoint from the repository, chain id checked
 * with eth_chainId before use); the evaluated networks through the existing connection helpers.
 * Nothing here signs or sends a transaction. Execution traces are not used: the configured RPC is
 * not known to support debug/trace methods.
 */
import { createHash } from 'crypto';
import { PublicKey } from '@solana/web3.js';
import { CHAINS, Chain } from './model';
import { connection, rpc } from '../solana/rpc';

const RH_RPC = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const TIMEOUT = Number(process.env.EVM_RPC_TIMEOUT_MS ?? 6000);
type Fetch = (url: string, init: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
let fetcher: Fetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) }) as any;
export function setEvmFetch(f: Fetch) { fetcher = f; chainChecked = null; }

let chainChecked: Promise<boolean> | null = null;
async function call(method: string, params: unknown[]) {
  const r = await fetcher(RH_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message ?? 'error'}`);
  return j.result;
}
async function evm(chain: Chain, method: string, params: unknown[]) {
  const want = (CHAINS[chain] as any).chainId as number;
  chainChecked ??= call('eth_chainId', []).then((id) => parseInt(id, 16) === want).catch(() => { chainChecked = null; return false; });
  if (!(await chainChecked)) throw new Error(`the configured RPC is not chain ${want}`);
  return call(method, params);
}

export interface TxEvidence { found: boolean; involvesSubject: boolean; status: 'PENDING' | 'CONFIRMED' | 'FINALIZED' | 'REVERTED' | 'NOT_FOUND'; block: string | null; blockHash: string | null; detail: string }

const pad = (a: string) => '0x' + a.slice(2).padStart(64, '0');
/** Is the transaction real, and does it involve the subject? Throws when the RPC is unavailable. */
export async function verifyTx(chain: Chain, txHash: string, subject: string): Promise<TxEvidence> {
  if (CHAINS[chain].family === 'evm') {
    const tx = await evm(chain, 'eth_getTransactionByHash', [txHash]);
    if (!tx) return { found: false, involvesSubject: false, status: 'NOT_FOUND', block: null, blockHash: null, detail: 'transaction not found' };
    if (!tx.blockNumber) return { found: true, involvesSubject: [tx.from, tx.to].map((x: string) => x?.toLowerCase()).includes(subject), status: 'PENDING', block: null, blockHash: null, detail: 'pending' };
    const rc = await evm(chain, 'eth_getTransactionReceipt', [txHash]);
    const fin = await evm(chain, 'eth_getBlockByNumber', ['finalized', false]).catch(() => null);
    const addrs = new Set<string>([tx.from, tx.to, rc?.contractAddress].filter(Boolean).map((x: string) => x.toLowerCase()));
    for (const l of rc?.logs ?? []) { addrs.add(String(l.address).toLowerCase()); for (const t of l.topics ?? []) if (String(t).toLowerCase() === pad(subject)) addrs.add(subject); }
    const reverted = rc && rc.status === '0x0';
    const finalized = fin && parseInt(fin.number, 16) >= parseInt(tx.blockNumber, 16);
    return { found: true, involvesSubject: addrs.has(subject), status: reverted ? 'REVERTED' : finalized ? 'FINALIZED' : 'CONFIRMED', block: String(parseInt(tx.blockNumber, 16)), blockHash: tx.blockHash, detail: `${addrs.size} addresses touched (sender, target, created contract, log emitters, indexed topics)` };
  }
  const conn = connection(chain as any);
  const t: any = await rpc('getTransaction', () => conn.getTransaction(txHash, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }));
  if (!t) return { found: false, involvesSubject: false, status: 'NOT_FOUND', block: null, blockHash: null, detail: 'transaction not found' };
  const keys: string[] = [...t.transaction.message.staticAccountKeys ?? t.transaction.message.accountKeys ?? []].map((k: PublicKey) => k.toBase58());
  for (const k of [...(t.meta?.loadedAddresses?.writable ?? []), ...(t.meta?.loadedAddresses?.readonly ?? [])]) keys.push(typeof k === 'string' ? k : k.toBase58());
  const fin = await rpc('getTransaction(finalized)', () => conn.getTransaction(txHash, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })).catch(() => null);
  return { found: true, involvesSubject: keys.includes(subject), status: t.meta?.err ? 'REVERTED' : fin ? 'FINALIZED' : 'CONFIRMED', block: String(t.slot), blockHash: null, detail: `${keys.length} accounts referenced` };
}

/** Runtime bytecode facts for an EVM address: contract or not, sha256 of the code, EIP-1967 implementation. */
export async function evmCode(chain: Chain, address: string) {
  const code: string = await evm(chain, 'eth_getCode', [address, 'latest']);
  const isContract = !!code && code !== '0x';
  let implementation: string | null = null;
  if (isContract) {
    const slot = await evm(chain, 'eth_getStorageAt', [address, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest']).catch(() => null);
    if (slot && /^0x0*[0-9a-f]{40}$/i.test(slot) && BigInt(slot) !== 0n) implementation = '0x' + slot.slice(-40).toLowerCase();
  }
  return { isContract, bytecodeSha256: isContract ? createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex') : null, implementation };
}

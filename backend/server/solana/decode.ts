/**
 * Decodes a serialized Solana transaction from its bytes. The agent's stated intent is never used:
 * everything here is read from the message (and, for v0, from the address lookup tables on-chain).
 */
import { AddressLookupTableAccount, Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { sha256 } from '../lib/util';
import { INFRASTRUCTURE, JUPITER_IX, PROGRAMS, PROGRAM_NAMES, SUPPORTED } from './programs';

export type Effect =
  | { kind: 'SOL_TRANSFER'; from: string; to: string; lamports: string }
  | { kind: 'TOKEN_TRANSFER'; program: string; source: string; destination: string; authority: string; amount: string; mint: string | null; decimals: number | null }
  | { kind: 'TOKEN_APPROVE'; program: string; source: string; delegate: string; owner: string; amount: string; mint: string | null }
  | { kind: 'TOKEN_REVOKE'; program: string; source: string; owner: string }
  | { kind: 'SET_AUTHORITY'; program: string; account: string; current: string; authorityType: string; newAuthority: string | null }
  | { kind: 'ACCOUNT_ASSIGN'; account: string; newOwnerProgram: string }
  | { kind: 'CLOSE_ACCOUNT'; program: string; account: string; destination: string; owner: string }
  | { kind: 'TOKEN_BURN'; program: string; account: string; mint: string; owner: string; amount: string }
  | { kind: 'MINT_TO'; program: string; mint: string; destination: string; authority: string; amount: string }
  | { kind: 'CREATE_ACCOUNT'; from: string; account: string; lamports: string; owner: string }
  | { kind: 'ATA_CREATE'; payer: string; account: string; wallet: string; mint: string; idempotent: boolean }
  | { kind: 'SWAP'; program: string; instruction: string; slippageBps: number; platformFeeBps: number; exactOut: boolean; amount: string | null; quotedAmount: string }
  | { kind: 'COMPUTE_BUDGET'; detail: string }
  | { kind: 'MEMO' }
  | { kind: 'NOOP'; detail: string }
  | { kind: 'UNKNOWN'; program: string; reason: string };

export interface DecodedInstruction {
  index: number;
  stackHeight: number;              // 1 = top level, >1 = inner (from simulation)
  program: string;
  programName: string | null;
  supported: boolean;
  accounts: string[];
  dataLength: number;
  effects: Effect[];
}

export interface DecodedTransaction {
  format: 'legacy' | 'v0';
  messageHash: string;               // sha256 of the serialized message: exactly what signers sign
  feePayer: string;
  recentBlockhash: string;
  signers: string[];
  writable: string[];
  accountKeys: string[];
  lookupTables: { address: string; resolved: boolean }[];
  instructions: DecodedInstruction[];
  programs: string[];
  unknownPrograms: string[];
  complete: boolean;                 // false when lookup tables could not be resolved
  issues: string[];
}

export class DecodeError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const u64 = (b: Buffer, o: number) => b.readBigUInt64LE(o).toString();

export function parseTransaction(b64: string): VersionedTransaction {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new DecodeError('INVALID_ENCODING', 'transaction must be a base64 string');
  const bytes = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  if (bytes.length < 64 || bytes.length > 1232) throw new DecodeError('INVALID_SIZE', `serialized transaction is ${bytes.length} bytes (max 1232)`);
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch (e: any) {
    throw new DecodeError('UNPARSEABLE', `not a valid transaction: ${e.message}`);
  }
}

export async function decodeTransaction(vtx: VersionedTransaction, conn: Connection | null): Promise<DecodedTransaction> {
  const msg = vtx.message;
  const issues: string[] = [];
  const lookups: AddressLookupTableAccount[] = [];
  const lookupInfo: { address: string; resolved: boolean }[] = [];
  for (const l of msg.addressTableLookups ?? []) {
    let acc: AddressLookupTableAccount | null = null;
    if (conn) {
      try { acc = (await conn.getAddressLookupTable(l.accountKey)).value; } catch (e: any) { issues.push(`lookup table ${l.accountKey.toBase58()} could not be fetched: ${e.message}`); }
    }
    lookupInfo.push({ address: l.accountKey.toBase58(), resolved: !!acc });
    if (acc) lookups.push(acc);
  }
  const complete = lookupInfo.every((l) => l.resolved);
  if (!complete) issues.push('address lookup tables unresolved: some accounts are unknown');

  let keys: string[];
  if (complete) {
    const ak = msg.getAccountKeys({ addressLookupTableAccounts: lookups });
    keys = [...ak.staticAccountKeys, ...(ak.accountKeysFromLookups?.writable ?? []), ...(ak.accountKeysFromLookups?.readonly ?? [])].map((k) => k.toBase58());
  } else {
    keys = msg.staticAccountKeys.map((k) => k.toBase58());
  }
  const nSigners = msg.header.numRequiredSignatures;
  // account order: static keys, then every lookup table's writable entries, then their readonly entries
  const nStatic = msg.staticAccountKeys.length;
  const nLookupWritable = (msg.addressTableLookups ?? []).reduce((s, l) => s + l.writableIndexes.length, 0);
  const writable = keys.filter((_k, i) => (i < nStatic ? msg.isAccountWritable(i) : i - nStatic < nLookupWritable));
  const key = (i: number) => keys[i] ?? `#unresolved:${i}`;

  const instructions: DecodedInstruction[] = msg.compiledInstructions.map((ix, index) => {
    const program = key(ix.programIdIndex);
    const accounts = ix.accountKeyIndexes.map(key);
    return decodeInstruction(index, 1, program, accounts, Buffer.from(ix.data));
  });

  const programs = [...new Set(instructions.map((i) => i.program))];
  return {
    format: msg.version === 'legacy' ? 'legacy' : 'v0',
    messageHash: sha256(Buffer.from(msg.serialize())),
    feePayer: key(0),
    recentBlockhash: msg.recentBlockhash,
    signers: keys.slice(0, nSigners),
    writable,
    accountKeys: keys,
    lookupTables: lookupInfo,
    instructions,
    programs,
    unknownPrograms: programs.filter((p) => !SUPPORTED.has(p)),
    complete,
    issues,
  };
}

const AUTHORITY_TYPES = ['MintTokens', 'FreezeAccount', 'AccountOwner', 'CloseAccount', 'TransferFeeConfig', 'WithheldWithdraw', 'CloseMint', 'InterestRate', 'PermanentDelegate', 'ConfidentialTransferMint', 'TransferHookProgramId', 'ConfidentialTransferFeeConfig', 'MetadataPointer', 'GroupPointer', 'GroupMemberPointer'];

export function decodeInstruction(index: number, stackHeight: number, program: string, accounts: string[], data: Buffer): DecodedInstruction {
  const base = { index, stackHeight, program, programName: PROGRAM_NAMES[program] ?? null, supported: SUPPORTED.has(program), accounts, dataLength: data.length };
  const unknown = (reason: string): DecodedInstruction => ({ ...base, supported: false, effects: [{ kind: 'UNKNOWN', program, reason }] });
  const a = (i: number) => accounts[i] ?? '';
  try {
    if (program === PROGRAMS.SYSTEM) {
      if (data.length < 4) return unknown('system instruction too short');
      const t = data.readUInt32LE(0);
      switch (t) {
        case 0: return { ...base, effects: [{ kind: 'CREATE_ACCOUNT', from: a(0), account: a(1), lamports: u64(data, 4), owner: new PublicKey(data.subarray(20, 52)).toBase58() }] };
        case 1: return { ...base, effects: [{ kind: 'ACCOUNT_ASSIGN', account: a(0), newOwnerProgram: new PublicKey(data.subarray(4, 36)).toBase58() }] };
        case 2: return { ...base, effects: [{ kind: 'SOL_TRANSFER', from: a(0), to: a(1), lamports: u64(data, 4) }] };
        case 3: return { ...base, effects: [{ kind: 'CREATE_ACCOUNT', from: a(0), account: a(1), lamports: u64(data, 4 + 32 + 8 + Number(data.readBigUInt64LE(36)) ), owner: '' }] };
        case 4: return { ...base, effects: [{ kind: 'NOOP', detail: 'advance nonce' }] };
        case 5: return { ...base, effects: [{ kind: 'SOL_TRANSFER', from: a(0), to: a(3), lamports: u64(data, 4) }] };
        case 6: case 12: return { ...base, effects: [{ kind: 'NOOP', detail: 'nonce account setup' }] };
        case 7: return { ...base, effects: [{ kind: 'SET_AUTHORITY', program, account: a(0), current: a(1), authorityType: 'NonceAuthority', newAuthority: new PublicKey(data.subarray(4, 36)).toBase58() }] };
        case 8: case 9: return { ...base, effects: [{ kind: 'NOOP', detail: 'allocate' }] };
        case 10: return { ...base, effects: [{ kind: 'ACCOUNT_ASSIGN', account: a(0), newOwnerProgram: 'with-seed' }] };
        case 11: return { ...base, effects: [{ kind: 'SOL_TRANSFER', from: a(0), to: a(2), lamports: u64(data, 4) }] };
        default: return unknown(`system instruction ${t}`);
      }
    }
    if (program === PROGRAMS.COMPUTE_BUDGET) {
      const t = data[0];
      const detail = t === 2 ? `unit limit ${data.readUInt32LE(1)}` : t === 3 ? `unit price ${u64(data, 1)} µlamports` : t === 1 ? `heap frame ${data.readUInt32LE(1)}` : t === 4 ? `loaded accounts limit ${data.readUInt32LE(1)}` : `instruction ${t}`;
      return { ...base, effects: [{ kind: 'COMPUTE_BUDGET', detail }] };
    }
    if (program === PROGRAMS.MEMO || program === PROGRAMS.MEMO_V1) return { ...base, effects: [{ kind: 'MEMO' }] };
    if (program === PROGRAMS.ATA) {
      const t = data.length === 0 ? 0 : data[0];
      if (t === 0 || t === 1) return { ...base, effects: [{ kind: 'ATA_CREATE', payer: a(0), account: a(1), wallet: a(2), mint: a(3), idempotent: t === 1 }] };
      if (t === 2) return { ...base, effects: [{ kind: 'TOKEN_TRANSFER', program, source: a(0), destination: a(2), authority: a(5), amount: 'all', mint: a(1), decimals: null }] };
      return unknown(`associated token account instruction ${t}`);
    }
    if (program === PROGRAMS.TOKEN || program === PROGRAMS.TOKEN_2022) {
      if (data.length < 1) return unknown('empty token instruction');
      const t = data[0];
      switch (t) {
        case 3: return { ...base, effects: [{ kind: 'TOKEN_TRANSFER', program, source: a(0), destination: a(1), authority: a(2), amount: u64(data, 1), mint: null, decimals: null }] };
        case 12: return { ...base, effects: [{ kind: 'TOKEN_TRANSFER', program, source: a(0), destination: a(2), authority: a(3), amount: u64(data, 1), mint: a(1), decimals: data[9] }] };
        case 4: return { ...base, effects: [{ kind: 'TOKEN_APPROVE', program, source: a(0), delegate: a(1), owner: a(2), amount: u64(data, 1), mint: null }] };
        case 13: return { ...base, effects: [{ kind: 'TOKEN_APPROVE', program, source: a(0), delegate: a(2), owner: a(3), amount: u64(data, 1), mint: a(1) }] };
        case 5: return { ...base, effects: [{ kind: 'TOKEN_REVOKE', program, source: a(0), owner: a(1) }] };
        case 6: {
          const hasNew = data[2] === 1;
          return { ...base, effects: [{ kind: 'SET_AUTHORITY', program, account: a(0), current: a(1), authorityType: AUTHORITY_TYPES[data[1]] ?? `type ${data[1]}`, newAuthority: hasNew ? new PublicKey(data.subarray(3, 35)).toBase58() : null }] };
        }
        case 7: return { ...base, effects: [{ kind: 'MINT_TO', program, mint: a(0), destination: a(1), authority: a(2), amount: u64(data, 1) }] };
        case 14: return { ...base, effects: [{ kind: 'MINT_TO', program, mint: a(0), destination: a(1), authority: a(2), amount: u64(data, 1) }] };
        case 8: case 15: return { ...base, effects: [{ kind: 'TOKEN_BURN', program, account: a(0), mint: a(1), owner: a(2), amount: u64(data, 1) }] };
        case 9: return { ...base, effects: [{ kind: 'CLOSE_ACCOUNT', program, account: a(0), destination: a(1), owner: a(2) }] };
        case 1: case 16: case 18: return { ...base, effects: [{ kind: 'NOOP', detail: 'initialize token account' }] };
        case 0: case 20: return { ...base, effects: [{ kind: 'NOOP', detail: 'initialize mint' }] };
        case 17: return { ...base, effects: [{ kind: 'NOOP', detail: 'sync native (wrap SOL)' }] };
        case 21: case 22: case 23: case 24: return { ...base, effects: [{ kind: 'NOOP', detail: `token utility ${t}` }] };
        case 10: case 11: return { ...base, effects: [{ kind: 'NOOP', detail: t === 10 ? 'freeze account' : 'thaw account' }] };
        default:
          return unknown(program === PROGRAMS.TOKEN_2022 ? `Token-2022 extension instruction ${t} is not interpreted` : `token instruction ${t}`);
      }
    }
    if (program === PROGRAMS.JUPITER_V6) {
      const j = data.length >= 8 ? JUPITER_IX[data.subarray(0, 8).toString('hex')] : undefined;
      if (!j) return unknown('Jupiter instruction not interpreted');
      let amount: string | null, quoted: string, slippageBps: number, platformFeeBps: number;
      if (j.at === 'tail') {
        if (data.length < 8 + j.tail) return unknown('Jupiter instruction too short');
        const tail = data.subarray(data.length - j.tail);
        amount = j.tail === 19 ? u64(tail, 0) : null;
        quoted = u64(tail, j.tail === 19 ? 8 : 0);
        slippageBps = tail.readUInt16LE(j.tail - 3);
        platformFeeBps = tail[j.tail - 1];
      } else {
        if (data.length < j.offset + 22) return unknown('Jupiter instruction too short');
        amount = u64(data, j.offset);
        quoted = u64(data, j.offset + 8);
        slippageBps = data.readUInt16LE(j.offset + 16);
        platformFeeBps = data.readUInt16LE(j.offset + 18);
      }
      if (slippageBps > 10_000) return unknown('Jupiter instruction has an implausible slippage field');
      return { ...base, effects: [{ kind: 'SWAP', program, instruction: j.name, slippageBps, platformFeeBps, exactOut: j.exactOut, amount, quotedAmount: quoted }] };
    }
    return unknown(PROGRAM_NAMES[program] ? `${PROGRAM_NAMES[program]} instructions are not interpreted` : 'program not recognised');
  } catch (e: any) {
    return unknown(`malformed instruction data: ${e.message}`);
  }
}

/** Inner instructions as returned by simulateTransaction (compiled form: indexes into accountKeys, base58 data). */
export function decodeInner(inner: any[] | null | undefined, keys: string[]): DecodedInstruction[] {
  const out: DecodedInstruction[] = [];
  for (const group of inner ?? []) {
    for (const ix of group.instructions ?? []) {
      if (typeof ix.programIdIndex !== 'number') continue; // parsed form is not requested
      const program = keys[ix.programIdIndex] ?? `#${ix.programIdIndex}`;
      const accounts = (ix.accounts ?? []).map((i: number) => keys[i] ?? `#${i}`);
      let data: Buffer;
      try { data = Buffer.from(bs58.decode(ix.data ?? '')); } catch { data = Buffer.alloc(0); }
      out.push(decodeInstruction(group.index, ix.stackHeight ?? 2, program, accounts, data));
    }
  }
  return out;
}

export const isInfrastructure = (p: string) => INFRASTRUCTURE.has(p);

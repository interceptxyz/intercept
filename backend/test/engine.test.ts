import { describe, expect, it, beforeEach } from 'vitest';
import { AddressLookupTableAccount, Keypair, PublicKey } from '@solana/web3.js';
import { buildContext } from '../server/engine/context';
import { decide, firewallChecks, riskChecks, systemChecks, History } from '../server/engine/checks';
import { policyConfigSchema, parsePolicy } from '../server/policy/schema';
import { decodeTransaction, parseTransaction } from '../server/solana/decode';
import { setFetcher } from '../server/market/prices';
import { dec } from '../server/lib/util';
import { FakeChain, USDC, WSOL_MINT, ix, priceFetcher, serialize, tokenAccountData } from './fake-chain';

const agent = Keypair.generate().publicKey;
const friend = Keypair.generate().publicKey;
const stranger = Keypair.generate().publicKey;
const agentUsdc = Keypair.generate().publicKey;
const friendUsdc = Keypair.generate().publicKey;
const SOL = 1_000_000_000;

let chain: FakeChain;
beforeEach(() => {
  chain = new FakeChain();
  chain.wallet(agent.toBase58(), 10 * SOL);
  chain.mint(USDC, 6);
  chain.token(agentUsdc.toBase58(), USDC, agent.toBase58(), 5_000_000_000n); // 5,000 USDC
  chain.token(friendUsdc.toBase58(), USDC, friend.toBase58(), 0n);
  setFetcher(priceFetcher(chain, { [WSOL_MINT]: { usd: 150.25 }, [USDC]: { usd: 1 } }));
});

const policy = (over: any = {}) => policyConfigSchema.parse({
  risk: { maxTransactionValueUsd: '1000', maxDailySpendUsd: '5000', maxSlippageBps: 50, ...over.risk },
  security: { allowedRecipients: [friend.toBase58()], ...over.security },
  execution: { requireApprovalAboveUsd: '500', failClosed: true, ...over.execution },
});
const NOHIST: History = { dailySpendUsd: 0n, protocolSpendUsd: {} };

async function run(tx: string, p = policy(), opts: { wallet?: string | null; history?: History; sim?: boolean } = {}) {
  const ctx = await buildContext(parseTransaction(tx), { conn: chain.connection(), network: 'mainnet-beta', wallet: opts.wallet === undefined ? agent.toBase58() : opts.wallet, runSimulation: opts.sim ?? true });
  const checks = [...systemChecks({ status: 'ACTIVE', mode: 'EVALUATION', walletVerified: false, orgEmergencyStop: false }), ...firewallChecks(ctx, p), ...riskChecks(ctx, p, opts.history ?? NOHIST)];
  return { ctx, checks, ...decide(checks), find: (c: string) => checks.find((x) => x.check === c)! };
}
const solMove = (lamportsOut: number) => { chain.setPost(agent.toBase58(), { lamports: 10 * SOL - lamportsOut, owner: '11111111111111111111111111111111', data: Buffer.alloc(0) }); };

describe('decoder', () => {
  it('decodes legacy and v0 transactions, signers, writables and lookup tables from the bytes', async () => {
    const legacy = await decodeTransaction(parseTransaction(serialize(agent, [ix.solTransfer(agent, friend, SOL)], [], true)), null);
    expect(legacy.format).toBe('legacy');
    expect(legacy.signers).toEqual([agent.toBase58()]);
    expect(legacy.instructions[0].effects[0]).toEqual({ kind: 'SOL_TRANSFER', from: agent.toBase58(), to: friend.toBase58(), lamports: String(SOL) });

    const lutKey = Keypair.generate().publicKey;
    const lut = new AddressLookupTableAccount({ key: lutKey, state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [friendUsdc, new PublicKey(USDC)] } });
    chain.luts.set(lutKey.toBase58(), [friendUsdc, new PublicKey(USDC)]);
    const v0b64 = serialize(agent, [ix.transferChecked(agentUsdc, new PublicKey(USDC), friendUsdc, agent, 10_000_000n, 6)], [lut]);
    const v0 = await decodeTransaction(parseTransaction(v0b64), chain.connection());
    expect(v0.format).toBe('v0');
    expect(v0.lookupTables).toEqual([{ address: lutKey.toBase58(), resolved: true }]);
    expect(v0.writable).toContain(friendUsdc.toBase58());
    expect(v0.instructions[0].effects[0]).toMatchObject({ kind: 'TOKEN_TRANSFER', destination: friendUsdc.toBase58(), mint: USDC, amount: '10000000', decimals: 6 });
    // unresolved lookup table: decoding is marked incomplete, never guessed
    chain.luts.clear();
    const inc = await decodeTransaction(parseTransaction(v0b64), chain.connection());
    expect(inc.complete).toBe(false);
  });

  it('reads Jupiter slippage from the instruction tail and classifies unknown programs', async () => {
    const d = await decodeTransaction(parseTransaction(serialize(agent, [ix.jupiterRoute(agent, [agentUsdc], 1_000_000n, 6_000_000n, 300), ix.unknown(stranger, agent)])), null);
    expect(d.instructions[0].effects[0]).toMatchObject({ kind: 'SWAP', slippageBps: 300, amount: '1000000', quotedAmount: '6000000' });
    expect(d.instructions[1].effects[0].kind).toBe('UNKNOWN');
    expect(d.unknownPrograms).toEqual([stranger.toBase58()]);
  });

  it('matches the Jupiter v6 on-chain IDL discriminators and decodes v2 head layouts', async () => {
    const { JUPITER_IX } = await import('../server/solana/programs');
    const idl: Record<string, string> = { route: 'e517cb977ae3ad2a', shared_accounts_route: 'c1209b3341d69c81', exact_out_route: 'd033ef977b2bed5c', route_v2: 'bb64facc31c4af14', shared_accounts_route_v2: 'd19853937cfed8e9', exact_out_route_v2: '9d8ab85215f4f324', shared_accounts_exact_out_route_v2: '3560e5cad8bbfa18', route_with_attestation: 'a0752c34dc4d5140', shared_accounts_route_with_attestation: '252ef97ec9a238ca' };
    for (const [name, disc] of Object.entries(idl)) expect(JUPITER_IX[disc]?.name).toBe(name);
    const { decodeInstruction } = await import('../server/solana/decode');
    const data = Buffer.alloc(9 + 22 + 6);
    Buffer.from('d19853937cfed8e9', 'hex').copy(data, 0); data[8] = 3;
    data.writeBigUInt64LE(5_000_000n, 9); data.writeBigUInt64LE(81_000n, 17); data.writeUInt16LE(75, 25); data.writeUInt16LE(20, 27);
    const d = decodeInstruction(0, 1, 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', [], data);
    expect(d.effects[0]).toMatchObject({ kind: 'SWAP', instruction: 'shared_accounts_route_v2', amount: '5000000', quotedAmount: '81000', slippageBps: 75, platformFeeBps: 20 });
  });

  it('rejects garbage', () => {
    expect(() => parseTransaction('not base64!')).toThrow(/base64/);
    expect(() => parseTransaction(Buffer.alloc(100, 7).toString('base64'))).toThrow();
  });
});

describe('policy semantics', () => {
  it('rejects floats, unknown fields and allow/block overlaps', () => {
    expect(parsePolicy({ risk: { maxTransactionValueUsd: 1000 } }).ok).toBe(false);
    expect(parsePolicy({ risk: { maxTransactionValueUsd: '1e3' } }).ok).toBe(false);
    expect(parsePolicy({ risk: { surprise: '1' } }).ok).toBe(false);
    const r = parsePolicy({ security: { allowedRecipients: [friend.toBase58()], blockedRecipients: [friend.toBase58()] } });
    expect(r.ok).toBe(false);
  });
});

describe('decisions', () => {
  it('allows a priced SOL transfer to an allowlisted recipient and values it exactly', async () => {
    solMove(2 * SOL + 5000);
    const r = await run(serialize(agent, [ix.solTransfer(agent, friend, 2 * SOL)]));
    expect(r.ctx.flowSource).toBe('simulation');
    expect(r.ctx.valueUsd).toBe(dec('300.50075125')); // 2.000005 SOL × 150.25
    expect(r.decision).toBe('ALLOW');
    expect(r.find('MAX_TRANSACTION_VALUE').status).toBe('PASSED');
  });

  it('blocks unknown recipients when blockUnknownRecipients and no allowlist', async () => {
    solMove(SOL);
    const r = await run(serialize(agent, [ix.solTransfer(agent, stranger, SOL)]), policy({ security: { allowedRecipients: [] } }));
    expect(r.decision).toBe('DENY');
    expect(r.reasons.map((x) => x.code)).toContain('SEC_UNKNOWN_RECIPIENT');
  });

  it('denies above the transaction limit, requires approval above the threshold', async () => {
    solMove(4 * SOL);
    expect((await run(serialize(agent, [ix.solTransfer(agent, friend, 4 * SOL)]))).decision).toBe('REQUIRE_APPROVAL'); // 601 USD > 500
    solMove(7 * SOL);
    const r = await run(serialize(agent, [ix.solTransfer(agent, friend, 7 * SOL)]));
    expect(r.decision).toBe('DENY');
    expect(r.find('MAX_TRANSACTION_VALUE')).toMatchObject({ status: 'FAILED', observed: '1051.75', limit: '1000', unit: 'USD' });
  });

  it('counts the last 24 h of authorized spending', async () => {
    solMove(2 * SOL);
    const r = await run(serialize(agent, [ix.solTransfer(agent, friend, 2 * SOL)]), policy(), { history: { dailySpendUsd: dec('4800'), protocolSpendUsd: {} } });
    expect(r.find('MAX_DAILY_SPEND')).toMatchObject({ status: 'FAILED', observed: '5100.5' });
  });

  it('fails closed without prices; asks a human when failClosed is false', async () => {
    setFetcher(priceFetcher(chain, {}, { down: true }));
    solMove(SOL);
    const tx = serialize(agent, [ix.solTransfer(agent, friend, SOL)]);
    const closed = await run(tx);
    expect(closed.decision).toBe('DENY');
    expect(closed.find('MAX_TRANSACTION_VALUE').status).toBe('UNCERTAIN');
    expect((await run(tx, policy({ execution: { failClosed: false } }))).decision).toBe('REQUIRE_APPROVAL');
  });

  it('treats stale prices as missing', async () => {
    setFetcher(priceFetcher(chain, { [WSOL_MINT]: { usd: 150, slotLag: 5000 } }));
    solMove(SOL);
    const r = await run(serialize(agent, [ix.solTransfer(agent, friend, SOL)]));
    expect(r.find('MAX_TRANSACTION_VALUE').status).toBe('UNCERTAIN');
    expect(r.ctx.valueIssues.join()).toMatch(/stale price/);
  });

  it('denies delegate approvals and authority changes', async () => {
    const a = await run(serialize(agent, [ix.approve(agentUsdc, stranger, agent, 2n ** 64n - 1n)]));
    expect(a.reasons.map((x) => x.code)).toContain('SEC_DELEGATE_APPROVAL');
    const b = await run(serialize(agent, [ix.setAuthority(agentUsdc, agent, stranger)]));
    expect(b.decision).toBe('DENY');
    expect(b.find('AUTHORITY_CHANGES').observed).toContain('AccountOwner');
  });

  it('handles unknown instructions as configured', async () => {
    const tx = serialize(agent, [ix.unknown(stranger, agent)]);
    expect((await run(tx)).reasons.map((x) => x.code)).toContain('SEC_UNKNOWN_INSTRUCTION');
    const lenient = await run(tx, policy({ security: { unknownInstructions: 'REQUIRE_APPROVAL' }, risk: { maxLeverage: null, maxSlippageBps: null } }));
    expect(lenient.decision).toBe('REQUIRE_APPROVAL');
  });

  it('denies on simulation failure and when mandatory simulation is unavailable', async () => {
    chain.simError = { InstructionError: [0, 'Custom(1)'] };
    const f = await run(serialize(agent, [ix.solTransfer(agent, friend, SOL)]));
    expect(f.reasons.map((x) => x.code)).toContain('SEC_SIMULATION_FAILED');
    chain.simError = null;
    chain.failRpc = 'simulateTransaction';
    const u = await run(serialize(agent, [ix.solTransfer(agent, friend, SOL)]));
    expect(u.decision).toBe('DENY');
    expect(u.find('SIMULATION')).toMatchObject({ status: 'UNCERTAIN', code: 'SEC_SIMULATION_UNAVAILABLE' });
    expect(u.ctx.simulation!.reason).toMatch(/RPC_UNAVAILABLE/);
  });

  it('catches outflows the instructions do not explain', async () => {
    solMove(5 * SOL); // instruction says 0.1 SOL, simulation says 5 SOL leave
    const r = await run(serialize(agent, [ix.solTransfer(agent, friend, SOL / 10)]));
    expect(r.find('UNEXPECTED_OUTFLOWS').status).toBe('FAILED');
    expect(r.decision).toBe('DENY');
  });

  it('resolves token recipients to their owner wallets', async () => {
    chain.setPost(agentUsdc.toBase58(), { lamports: 2_039_280, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: tokenAccountData(USDC, agent.toBase58(), 4_900_000_000n) });
    const r = await run(serialize(agent, [ix.transferChecked(agentUsdc, new PublicKey(USDC), friendUsdc, agent, 100_000_000n, 6)]));
    expect(r.ctx.transfers[0]).toMatchObject({ kind: 'TOKEN', recipient: friend.toBase58(), mint: USDC, raw: '100000000' });
    expect(r.ctx.valueUsd).toBe(dec('100'));
    expect(r.decision).toBe('ALLOW');
  });

  it('enforces swap slippage read from the transaction', async () => {
    const tx = (bps: number) => serialize(agent, [ix.jupiterRoute(agent, [agentUsdc], 1_000_000n, 6_000n, bps)]);
    expect((await run(tx(300))).find('MAX_SLIPPAGE')).toMatchObject({ status: 'FAILED', observed: '300', limit: '50' });
    expect((await run(tx(30))).find('MAX_SLIPPAGE').status).toBe('PASSED');
  });

  it('denies when the agent wallet does not sign', async () => {
    const other = Keypair.generate().publicKey;
    chain.wallet(other.toBase58(), SOL);
    const r = await run(serialize(other, [ix.solTransfer(other, friend, 1000)]));
    expect(r.reasons.map((x) => x.code)).toContain('SEC_WALLET_NOT_SIGNER');
  });

  it('reports unsupported checks explicitly instead of passing them', async () => {
    solMove(SOL);
    const r = await run(serialize(agent, [ix.solTransfer(agent, friend, SOL)]), policy({ risk: { maxDrawdownBps: 1000 } }));
    expect(r.find('MAX_DRAWDOWN')).toMatchObject({ status: 'UNSUPPORTED', effect: 'REQUIRE_APPROVAL' });
    expect(r.decision).toBe('REQUIRE_APPROVAL');
    expect(r.find('MAX_LEVERAGE').status).toBe('NOT_CONFIGURED');
  });

  it('emergency stop and paused agents deny everything', () => {
    expect(decide(systemChecks({ status: 'ACTIVE', mode: 'EVALUATION', walletVerified: true, orgEmergencyStop: true })).decision).toBe('DENY');
    expect(decide(systemChecks({ status: 'PAUSED', mode: 'EVALUATION', walletVerified: true, orgEmergencyStop: false })).reasons[0].code).toBe('SYS_AGENT_PAUSED');
    expect(decide(systemChecks({ status: 'ACTIVE', mode: 'ENFORCED_EXECUTION', walletVerified: false, orgEmergencyStop: false })).reasons[0].code).toBe('SYS_WALLET_UNVERIFIED');
  });
});

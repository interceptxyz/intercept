import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { Keypair, PublicKey, SystemProgram, TransactionMessage } from '@solana/web3.js';
import { alertFor, rulesSchema, refreshWallet, addWallet } from '../server/services/watch';
import { closePool, getPool, migrate } from '../server/db';
import { login } from '../server/services/identity';
import { setFetcher } from '../server/market/prices';
import { FakeChain, WSOL_MINT, ix, priceFetcher } from './fake-chain';

describe('alert rules', () => {
  const r = (x: any = {}) => rulesSchema.parse(x);
  const ev = (x: any) => ({ direction: 'OUTGOING', decision: 'ALLOW', reasons: [], valueOut: '50', valueIn: null, failed: false, ...x });
  it('alerts on outgoing by default, not on incoming', () => {
    expect(alertFor(ev({}), r())?.severity).toBe('LOW');
    expect(alertFor(ev({ direction: 'INCOMING', valueOut: null, valueIn: '10', decision: null }), r())).toBeNull();
    expect(alertFor(ev({ direction: 'INCOMING', valueOut: null, valueIn: '10', decision: null }), r({ incoming: true }))).not.toBeNull();
  });
  it('respects the minimum value, but never hides policy violations', () => {
    expect(alertFor(ev({ valueOut: '50' }), r({ minValueUsd: '100' }))).toBeNull();
    expect(alertFor(ev({ valueOut: '150' }), r({ minValueUsd: '100' }))).not.toBeNull();
    expect(alertFor(ev({ valueOut: '5', decision: 'DENY', reasons: ['SEC_DELEGATE_APPROVAL'] }), r({ minValueUsd: '100' }))?.severity).toBe('CRITICAL');
    expect(alertFor(ev({ valueOut: '5', decision: 'REQUIRE_APPROVAL' }), r({ minValueUsd: '100' }))?.severity).toBe('MEDIUM');
  });
  it('watches specific rule codes even when the decision is allowed', () => {
    const a = alertFor(ev({ outgoing: false, reasons: ['RISK_SLIPPAGE'] }), r({ outgoing: false, codes: ['RISK_SLIPPAGE'] }));
    expect(a?.why[0]).toMatch(/RISK_SLIPPAGE/);
  });
});

describe('wallet watch', () => {
  const chain = new FakeChain();
  const wallet = Keypair.generate().publicKey, other = Keypair.generate().publicKey;
  let orgId = '', userId = '';
  const SOL = 1_000_000_000;
  const landed = (sig: string, from: PublicKey, to: PublicKey, lamports: number, pre: number[], post: number[]) => {
    const msg = new TransactionMessage({ payerKey: from, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports })] }).compileToV0Message();
    chain.txs.set(sig, { slot: chain.slot, blockTime: Math.floor(Date.now() / 1000), transaction: { message: msg, signatures: [] }, meta: { err: null, preBalances: pre, postBalances: post, preTokenBalances: [], postTokenBalances: [], innerInstructions: [], logMessages: [], computeUnitsConsumed: 150 } });
  };
  beforeAll(async () => {
    const admin = new Client({ connectionString: process.env.DATABASE_URL!.replace(/\/[^/]+$/, '/postgres') });
    await admin.connect(); await admin.query('DROP DATABASE IF EXISTS intercept_test WITH (FORCE)'); await admin.query('CREATE DATABASE intercept_test'); await admin.end();
    await migrate();
    const s = await login({ did: 'did:watch', email: 'w@x.io', wallet: null }, null, null);
    userId = s.user.id;
    orgId = (await getPool().query('SELECT org_id FROM memberships WHERE user_id = $1', [userId])).rows[0].org_id;
    chain.wallet(wallet.toBase58(), 10 * SOL);
    setFetcher(priceFetcher(chain, { [WSOL_MINT]: { usd: 100 } }));
  });
  afterAll(async () => closePool());

  it('reads history silently, then alerts on new outgoing transactions', async () => {
    landed('sig-old', other, wallet, SOL, [5 * SOL, 9 * SOL], [4 * SOL, 10 * SOL]); // incoming, before watching
    chain.sigs.set(wallet.toBase58(), [{ signature: 'sig-old', slot: 1, err: null }]);
    const w = await addWallet(getPool(), orgId, userId, { address: wallet.toBase58(), label: 'Treasury', network: 'mainnet-beta', policyId: null, rules: { minValueUsd: '50' } });
    expect(await refreshWallet(getPool(), w, chain.connection())).toBe(1);
    let ev = (await getPool().query('SELECT * FROM watch_events WHERE wallet_id = $1', [w.id])).rows;
    expect(ev[0]).toMatchObject({ direction: 'INCOMING', alerted: false, decision: null });

    // a new outgoing transfer of 2 SOL ($200) to an address
    landed('sig-new', wallet, other, 2 * SOL, [10 * SOL, 1 * SOL], [8 * SOL - 5000, 3 * SOL]);
    chain.sigs.set(wallet.toBase58(), [{ signature: 'sig-new', slot: 2, err: null }, { signature: 'sig-old', slot: 1, err: null }]);
    const w2 = (await getPool().query('SELECT * FROM watched_wallets WHERE id = $1', [w.id])).rows[0];
    expect(await refreshWallet(getPool(), w2, chain.connection())).toBe(1);
    ev = (await getPool().query(`SELECT * FROM watch_events WHERE wallet_id = $1 AND signature = 'sig-new'`, [w.id])).rows;
    expect(ev[0]).toMatchObject({ direction: 'OUTGOING', decision: 'ALLOW', value_out_usd: '200.00', alerted: true });
    const al = (await getPool().query('SELECT * FROM alerts WHERE watched_wallet_id = $1', [w.id])).rows;
    expect(al).toHaveLength(1);
    expect(al[0].message).toMatch(/Treasury: outgoing \$200/);
    // nothing new: no duplicate
    const w3 = (await getPool().query('SELECT * FROM watched_wallets WHERE id = $1', [w.id])).rows[0];
    expect(await refreshWallet(getPool(), w3, chain.connection())).toBe(0);
  });
});

void ix;

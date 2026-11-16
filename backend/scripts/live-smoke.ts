// Live check against public RPC + price API (no database): decode, simulate, value, decide.
import { Keypair, PublicKey } from '@solana/web3.js';
import { buildContext } from '../server/engine/context';
import { decide, firewallChecks, riskChecks, systemChecks } from '../server/engine/checks';
import { DEFAULT_POLICY } from '../server/policy/schema';
import { parseTransaction } from '../server/solana/decode';
import { connection } from '../server/solana/rpc';
import { decStr } from '../server/lib/util';
import { ix, serialize } from '../test/fake-chain';

async function main() {
  const whale = new PublicKey(process.argv[2] ?? '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
  const to = Keypair.generate().publicKey;
  for (const [label, lamports] of [['0.5 SOL to an unknown address', 500_000_000], ['20 SOL to an unknown address', 20_000_000_000]] as const) {
    const tx = serialize(whale, [ix.solTransfer(whale, to, lamports)]);
    const ctx = await buildContext(parseTransaction(tx), { conn: connection('mainnet-beta'), network: 'mainnet-beta', wallet: whale.toBase58(), runSimulation: true });
    const pol = { ...DEFAULT_POLICY, security: { ...DEFAULT_POLICY.security, allowedRecipients: [to.toBase58()] } };
    const checks = [...systemChecks({ status: 'ACTIVE', mode: 'EVALUATION', walletVerified: false, orgEmergencyStop: false }), ...firewallChecks(ctx, pol), ...riskChecks(ctx, pol, { dailySpendUsd: 0n, protocolSpendUsd: {} })];
    const d = decide(checks);
    const sol = ctx.outflows.get('SOL');
    console.log(`\n${label}`);
    console.log(`  reason ${ctx.simulation?.reason}`); console.log(`  simulation ${ctx.simulation?.status} at slot ${ctx.simulation?.slot}, ${ctx.simulation?.unitsConsumed} CU`);
    console.log(`  SOL price ${sol?.price?.usdStr} (price slot ${sol?.price?.slot}, fresh ${sol?.fresh})`);
    console.log(`  value ${ctx.valueUsd === null ? 'unknown' : decStr(ctx.valueUsd, 2)} USD -> ${d.decision} ${d.reasons.map((r) => r.code).join(', ')}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

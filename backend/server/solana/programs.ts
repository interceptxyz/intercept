import { createHash } from 'crypto';

export const PROGRAMS = {
  SYSTEM: '11111111111111111111111111111111',
  COMPUTE_BUDGET: 'ComputeBudget111111111111111111111111111111',
  MEMO: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  MEMO_V1: 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  TOKEN: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN_2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ATA: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  JUPITER_V6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  STAKE: 'Stake11111111111111111111111111111111111111',
  BPF_UPGRADEABLE: 'BPFLoaderUpgradeab1e11111111111111111111111',
} as const;

export const PROGRAM_NAMES: Record<string, string> = {
  [PROGRAMS.SYSTEM]: 'System Program',
  [PROGRAMS.COMPUTE_BUDGET]: 'Compute Budget',
  [PROGRAMS.MEMO]: 'Memo',
  [PROGRAMS.MEMO_V1]: 'Memo (v1)',
  [PROGRAMS.TOKEN]: 'SPL Token',
  [PROGRAMS.TOKEN_2022]: 'Token-2022',
  [PROGRAMS.ATA]: 'Associated Token Account',
  [PROGRAMS.JUPITER_V6]: 'Jupiter Aggregator v6',
  [PROGRAMS.STAKE]: 'Stake Program',
  [PROGRAMS.BPF_UPGRADEABLE]: 'BPF Upgradeable Loader',
};

/** Always permitted by a program allowlist: their effects are inspected by the other rules. */
export const INFRASTRUCTURE = new Set<string>([PROGRAMS.SYSTEM, PROGRAMS.COMPUTE_BUDGET, PROGRAMS.MEMO, PROGRAMS.MEMO_V1, PROGRAMS.TOKEN, PROGRAMS.TOKEN_2022, PROGRAMS.ATA]);

/** Programs whose value flows are understood (transfers, swaps). Anything else is "unknown". */
export const SUPPORTED = new Set<string>([...INFRASTRUCTURE, PROGRAMS.JUPITER_V6]);

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const anchorDisc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8).toString('hex');

/**
 * Jupiter v6 swap instructions. The fixed-size arguments sit at the end of the instruction data,
 * after the variable-length route plan, so they are read from the tail:
 *   ..., [in_amount|out_amount u64], [quoted_out|quoted_in u64], slippage_bps u16, platform_fee_bps u8
 * The *_with_token_ledger variants have no first amount (11-byte tail).
 */
export const JUPITER_IX: Record<string, { name: string; exactOut: boolean; tail: 19 | 11 }> = {
  [anchorDisc('route')]: { name: 'route', exactOut: false, tail: 19 },
  [anchorDisc('shared_accounts_route')]: { name: 'shared_accounts_route', exactOut: false, tail: 19 },
  [anchorDisc('route_with_token_ledger')]: { name: 'route_with_token_ledger', exactOut: false, tail: 11 },
  [anchorDisc('shared_accounts_route_with_token_ledger')]: { name: 'shared_accounts_route_with_token_ledger', exactOut: false, tail: 11 },
  [anchorDisc('exact_out_route')]: { name: 'exact_out_route', exactOut: true, tail: 19 },
  [anchorDisc('shared_accounts_exact_out_route')]: { name: 'shared_accounts_exact_out_route', exactOut: true, tail: 19 },
};

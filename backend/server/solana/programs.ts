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
 * Jupiter v6 swap instructions, from the program's on-chain Anchor IDL.
 * v1 layouts put the variable-length route plan first, so the fixed fields are read from the tail:
 *   ..., [in_amount|out_amount u64], [quoted_out|quoted_in u64], slippage_bps u16, platform_fee_bps u8
 *   (*_with_token_ledger: no first amount, 11-byte tail)
 * v2 layouts put the fixed fields first, after the discriminator (and the u8 `id` for shared accounts):
 *   [in_amount|out_amount u64], [quoted u64], slippage_bps u16, platform_fee_bps u16, positive_slippage_bps u16, route_plan...
 */
export type JupiterLayout = { name: string; exactOut: boolean } & ({ at: 'tail'; tail: 19 | 11 } | { at: 'head'; offset: 8 | 9 });
export const JUPITER_IX: Record<string, JupiterLayout> = {
  [anchorDisc('route')]: { name: 'route', exactOut: false, at: 'tail', tail: 19 },
  [anchorDisc('shared_accounts_route')]: { name: 'shared_accounts_route', exactOut: false, at: 'tail', tail: 19 },
  [anchorDisc('route_with_token_ledger')]: { name: 'route_with_token_ledger', exactOut: false, at: 'tail', tail: 11 },
  [anchorDisc('shared_accounts_route_with_token_ledger')]: { name: 'shared_accounts_route_with_token_ledger', exactOut: false, at: 'tail', tail: 11 },
  [anchorDisc('exact_out_route')]: { name: 'exact_out_route', exactOut: true, at: 'tail', tail: 19 },
  [anchorDisc('shared_accounts_exact_out_route')]: { name: 'shared_accounts_exact_out_route', exactOut: true, at: 'tail', tail: 19 },
  [anchorDisc('route_v2')]: { name: 'route_v2', exactOut: false, at: 'head', offset: 8 },
  [anchorDisc('exact_out_route_v2')]: { name: 'exact_out_route_v2', exactOut: true, at: 'head', offset: 8 },
  [anchorDisc('shared_accounts_route_v2')]: { name: 'shared_accounts_route_v2', exactOut: false, at: 'head', offset: 9 },
  [anchorDisc('shared_accounts_exact_out_route_v2')]: { name: 'shared_accounts_exact_out_route_v2', exactOut: true, at: 'head', offset: 9 },
  [anchorDisc('route_with_attestation')]: { name: 'route_with_attestation', exactOut: false, at: 'head', offset: 8 },
  [anchorDisc('shared_accounts_route_with_attestation')]: { name: 'shared_accounts_route_with_attestation', exactOut: false, at: 'head', offset: 9 },
};

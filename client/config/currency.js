// SPL currency configuration for the menu wallet plate.
//
// PARAMETERIZED — do NOT hardcode "SOL". Frag Arena will settle on an SPL token
// whose ticker + mint are NOT YET KNOWN. This is the single place those land once
// decided; the menu reads `tokenSymbol` for the plate label and treats a null
// `tokenMint` as "wallet integration not wired yet" (renders a CONNECT stub, no
// web3/wallet-adapter dependency).
//
// TODO(currency): replace `tokenSymbol` with the real ticker and set `tokenMint`
// to the deployed SPL mint address, then wire a real wallet adapter behind the
// CONNECT affordance (client/factories or a dedicated wallet module). Until then
// the plate is purely visual.
export const CURRENCY = {
  tokenSymbol: 'TBD',   // placeholder ticker — NOT the final token
  tokenMint: null,      // SPL mint address — unknown; null gates real integration
  chain: 'solana',
}

export default CURRENCY

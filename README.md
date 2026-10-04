# meteora-tx-mcp

MCP server that builds **unsigned** Meteora DLMM transactions. It reads pool and position state, assembles the instructions, and returns version-0 transactions a wallet can sign. It does not have a fee-payer key, does not sign the fee payer, and does not submit anything.

A new position account is the exception a dapp already makes: the server generates that key, partial-signs the transactions that need it, and discards the secret. The wallet still signs as the fee payer. Those partial signatures are bound to the blockhash in the package. If the hash expires, call the tool again.

The builders follow the transaction-construction rules pinned in `live-dlmm`:

- Slippage is basis points in, SDK percent out. `1500` means 15%, not 0.15% and not 15 bps.
- Opens use one extended PositionV2 per 525 bins (`initializePosition2` plus length increases), with deposits chunked at 70 bins. Create and extend stay on the first chunk of each position. Duplicate bin-array inits are dropped.
- Wide transactions are compiled with the mainnet DLMM address lookup table `JA5F83HUK9L78Y12TRLCsJZbu3Tv8pCK1GfK8mVNp1sz`. A transaction over 1232 bytes is refused.
- `singleSidedX` defaults to false. A token-Y bid below the active bin deposits nothing when that flag is true.
- The one-sided rebalance path refuses a simulation that would deposit token X unless `allowTokenX` is true.
- Rebalance sets a 1,400,000 compute-unit limit. The SDK's own estimate is too low for a wide withdraw-and-redeposit.
- Priority fee defaults to 200,000 micro-lamports. There is no Jito tip. The signer chooses how to land the transactions.

SDK pin: `@meteora-ag/dlmm` 1.9.14, the version the bot's tests run against. The server loads that package's CommonJS build. Its ESM file imports an Anchor directory, which current Node rejects.

## Run

```bash
cd ~/mcps/meteora-tx-mcp
npm install
cp .env.example .env   # then set SOLANA_RPC_URL
npm test
npm run build
node dist/index.js
```

`.env` is read from the current working directory at startup (dotenv is loaded when installed). Each variable is optional. `rpcUrl` on a tool call still overrides the environment. This server is mainnet: the lookup table address is the mainnet table.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SOLANA_RPC_URL` | none (required) | Solana JSON-RPC HTTP URL. |
| `MCP_HTTP_ENABLED` | `true` | Also serve streamable HTTP beside stdio. `false` for stdio only. |
| `MCP_HTTP_PORT` | `5150` | HTTP listen port. |
| `MCP_HTTP_HOST` | `127.0.0.1` | Bind interface. A loopback bind rejects non-loopback `Host` headers; `0.0.0.0` or `::` binds every interface and skips that check. |
| `MCP_RAW_TOOLS` | `false` | Serve only the `_raw` tools (integer bin ids, base-unit amounts, bps shares) and leave the decimal tools unregistered. `false` keeps both families: the decimal tools are the default surface and the `_raw` tools stay alongside them. |

The process speaks MCP over stdio and, unless disabled, also listens for streamable-HTTP MCP on `http://127.0.0.1:5150/mcp` (stateless: one MCP session per POST, JSON responses). Logs go to stderr. Configure stdio-only hosts as before — they are unaffected; the extra listener does not touch stdin/stdout:

```json
{
  "mcpServers": {
    "meteora-tx": {
      "command": "node",
      "args": ["/home/geeklad/mcps/meteora-tx-mcp/dist/index.js"],
      "env": { "SOLANA_RPC_URL": "https://your-mainnet-rpc" }
    }
  }
}
```

## Tools

| Tool | What the wallet will be asked to sign |
| --- | --- |
| `build_open_position` | Create a position and deposit from decimal amounts and a price window (`lowerPrice`/`upperPrice` or `lowerBpsOffActive`/`upperBpsOffActive`). |
| `build_open_position_raw` | Same, with integer bin ids and raw base-unit amount strings. |
| `build_add_liquidity` | Add to an existing position from decimal amounts; the price window is optional and defaults to the position's bins. |
| `build_add_liquidity_raw` | Same, with integer bin ids and raw base-unit amount strings. |
| `build_remove_liquidity` | Remove `removeSharePercent` out of 100, optionally bounded by a price window. `shouldClaimAndClose` requires 100. |
| `build_remove_liquidity_raw` | Same, with the share in bps out of 10000 and integer bin ids. |
| `build_claim_fees` | Claim swap fees. `includeRewards` also claims liquidity-mining rewards. |
| `build_close_position` | Close a position that is already empty. |
| `build_rebalance_position` | Withdraw and redeposit on the same position from decimal top-ups and a price window; withdraw shares are percent. |
| `build_rebalance_position_raw` | Same, with integer bin ids, raw top-up strings, and withdraw shares in bps. |

The decimal tools (`build_open_position`, `build_add_liquidity`, `build_remove_liquidity`, `build_rebalance_position`) take human amounts and prices: `amountXUi` of `"1.5"` is 1.5 tokens, `lowerPrice` of `150.25` is the pool price of token X in token Y, and `lowerBpsOffActive` of `-500` is 5 percent below the current price. The lower price maps to the nearest bin at or below it and the upper price to the nearest bin at or above it, and the response reports the resolved bin ids plus their exact bin prices so a caller can check the rounding. The raw tools keep the exact on-chain units: bin ids and base-unit integer strings, lamports for SOL.

The raw tools are named for the fields they keep: `_raw` versions take the inputs the SDK itself needs (`lowerBinId`, `amountXRaw`). The decimal versions are wrappers that resolve decimals to those same units before calling the same builders, so both paths produce identical packages.

Set `MCP_RAW_TOOLS=true` to hide the decimal tools and serve only the `_raw` set — the decimal tools are then unregistered, so an MCP host cannot list or call them. The default (`false`) exposes both families.

Each tool returns a JSON package:

- `package.transactions[].base64` is a version-0 transaction. Deserialize with `VersionedTransaction.deserialize`.
- `unsignedSigners` is the fee payer. `signedBy` lists ephemeral position keys already signed.
- `recentBlockhash` and `lastValidBlockHeight` come from `getLatestBlockhash("confirmed")`.
- `submitInOrder` is true. Later chunks depend on earlier ones, and they share one blockhash. If the hash expires mid-way, rebuild. Do not retry an expired package.
- `warnings` covers a token-X deposit, a window above the active bin, a missing lookup table, and multi-transaction expiry.

Amounts in `amounts.xUi` / `yUi` are for reading the package. The instructions use the raw strings. On the decimal tools, `requestedAmounts` echoes the decimal amounts that came in, and `binWindow.requestedLowerPrice`/`requestedUpperPrice` (or the bps fields) echo the request while `resolvedLowerPrice`/`resolvedUpperPrice` are the exact prices the resolved bins sit at.

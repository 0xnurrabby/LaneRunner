# Web3RunnerLogger (ethers.js) setup

This repo includes an **ethers.js** helper and a **Menu button** to call your deployed logger contract:

```solidity
function web3RunnerInteract(bytes32 action, bytes calldata data) external;
```

## 1) Set your contract address
Edit `src/main.js` and set:

```js
const LOGGER_CONTRACT = "0xYOUR_DEPLOYED_LOGGER_ADDRESS";
```

Default is the zero-address, and the app will warn you until you set it.

## 2) Use the UI (recommended)
1. Open the app
2. Go to **Menu**
3. Tap **Log interaction (BaseScan)**
4. Confirm the transaction in the wallet prompt

After it confirms, check **BaseScan → Contract → Events**. You should see `GameInteracted` entries.

## 3) Direct call example (inside the app)
The button calls this helper:

```js
await logInteractionWithEthers("RUN", "0x");
```

- `actionText` becomes `ethers.encodeBytes32String(actionText)`
- `dataHex` is extra payload (optional). Keep it `"0x"` if you don't need it.

# Ethereum Proof-of-Stake Devnet

Fork from https://github.com/OffchainLabs/eth-pos-devnet and support cancun/deneb fork

Refer to https://docs.prylabs.network/docs/advanced/proof-of-stake-devnet for the details

## Prerequisites

- the `latest` docker-compose, the compose file requires version 2.24.0

## Quick start

**Clean and reset all data**

```
make reset
```

**Init genesis**

If you would like to fund address you have, just add `.env` file with following configurations

```
# comma separated address
GENESIS_ADDRESS=0x0001aEBC06288F578Eb01002a99E854cED86bC4F
# the default balance
GENESIS_BALANCE_default=0xfffffffffffffffffffff
GENESIS_BALANCE_0x0001aEBC06288F578Eb01002a99E854cED86bC4F=0x64
GENESIS_NONCE_0x0002538C7BB308B5042f279e2C10b466b80797C9=0x1
GENESIS_CODE_0x0002538C7BB308B5042f279e2C10b466b80797C9=0x363d3d373d3d3d363d73bebebebebebebebebebebebebebebebebebebebe5af43d82803e903d91602b57fd5bf3
```

And the result will be

```json
{
  "0001aebc06288f578eb01002a99e854ced86bc4f": {
    "balance": "0x64"
  },
  "0002538c7bb308b5042f279e2c10b466b80797c9": {
    "nonce": "0x1",
    "code": "0x363d3d373d3d3d363d73bebebebebebebebebebebebebebebebebebebebe5af43d82803e903d91602b57fd5bf3",
    "balance": "0x0"
  },
  "000352a341aac0a2437c33edceada93bf4908fd8": {
    "balance": "0xfffffffffffffffffffff"
  }
}
```

```
make init
```

**Start**

```
make start
```

## Genesis contract

- 0x4242424242424242424242424242424242424242 the deposit contract
- 0x4e59b44847b379578588920ca78fbf26c0b4956c [DeterministicCreate2Deployer](https://github.com/Arachnid/deterministic-deployment-proxy)
- 0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24 [EIP-1820](https://eips.ethereum.org/EIPS/eip-1820) Pseudo-introspection Registry Contract
- 0x13b0D85CcB8bf860b6b79AF3029fCA081AE9beF2 [Create2Deployer](https://optimistic.etherscan.io/address/0x13b0D85CcB8bf860b6b79AF3029fCA081AE9beF2#code)
- 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02 [EIP-4788](https://eips.ethereum.org/EIPS/eip-4788) Beacon Roots contract
- 0x0F792be4B0c0cb4DAE440Ef133E90C0eCD48CCCC [EIP-2935](https://eips.ethereum.org/EIPS/eip-2935) Serve historical block hashes from state
- 0x0c15F14308530b7CDB8460094BbB9cC28b9AaaAA [EIP-7002](https://eips.ethereum.org/EIPS/eip-7002) Execution layer triggerable withdrawals
- 0x00431F263cE400f4455c2dCf564e53007Ca4bbBb [EIP-7251](https://eips.ethereum.org/EIPS/eip-7251) Increase the MAX_EFFECTIVE_BALANCE
- 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed [CreateX](https://github.com/pcaversaccio/createx)
- 0xcA11bde05977b3631167028862bE2a173976CA11 [Multicall3](https://www.multicall3.com/)
- 0x000000000022D473030F116dDEE9F6B43aC78BA3 [Permit2](https://github.com/Uniswap/permit2)

## Custom block pruducing period

Update it in the `config/config.yml`

```
SECONDS_PER_SLOT: 3
SLOTS_PER_EPOCH: 6
```

## The fee recipient address for testing

```
WARNING: These accounts, and their private keys, are publicly known.
Any funds sent to them on Mainnet or any other live network WILL BE LOST.

Mnemonic

test test test test test test test test test test test junk

Address

0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

key

0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

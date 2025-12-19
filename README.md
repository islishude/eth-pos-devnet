# Ethereum Proof-of-Stake Devnet

Fork from https://github.com/OffchainLabs/eth-pos-devnet and support Fusaka(Fulu/Osaka) fork

Refer to https://docs.prylabs.network/docs/advanced/proof-of-stake-devnet for the details

## Prerequisites

- the `latest` docker-compose

## Quick start

**Clean and reset all data**

```
make reset
```

**Initialize the devnet (only required on first run)**

```
make init
```

**Start**

```
make start
```

## Genesis contract

### System

- 0x00000000219ab540356cbb839cbe05303d7705fa the deposit contract
- 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02 [EIP-4788](https://eips.ethereum.org/EIPS/eip-4788) Beacon Roots contract
- 0x0000F90827F1C53a10cb7A02335B175320002935 [EIP-2935](https://eips.ethereum.org/EIPS/eip-2935) Serve historical block hashes from state
- 0x0000BBdDc7CE488642fb579F8B00f3a590007251 [EIP-7251](https://eips.ethereum.org/EIPS/eip-7251) Increase the MAX_EFFECTIVE_BALANCE
- 0x00000961Ef480Eb55e80D19ad83579A64c007002 [EIP-7002](https://eips.ethereum.org/EIPS/eip-7002) Execution layer triggerable withdrawals

### Utils

- 0x4e59b44847b379578588920ca78fbf26c0b4956c [DeterministicCreate2Deployer](https://github.com/Arachnid/deterministic-deployment-proxy)
- 0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24 [EIP-1820](https://eips.ethereum.org/EIPS/eip-1820) Pseudo-introspection Registry Contract
- 0x13b0D85CcB8bf860b6b79AF3029fCA081AE9beF2 [Create2Deployer](https://optimistic.etherscan.io/address/0x13b0D85CcB8bf860b6b79AF3029fCA081AE9beF2#code)
- 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed [CreateX](https://github.com/pcaversaccio/createx)
- 0xcA11bde05977b3631167028862bE2a173976CA11 [Multicall3](https://www.multicall3.com/)
- 0x000000000022D473030F116dDEE9F6B43aC78BA3 [Permit2](https://github.com/Uniswap/permit2)

## Custom block pruducing period

Update it in the `config/config.yml`

```
SECONDS_PER_SLOT: 3
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

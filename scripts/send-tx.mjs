import { JsonRpcProvider, Wallet, parseEther } from "ethers";

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const PRIV_KEY = process.env.PRIV_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // devnet key from README
const TO = process.env.TO || "0x0000000000000000000000000000000000000001";
const VALUE = process.env.VALUE || "0.01"; // ETH

async function main() {
  const provider = new JsonRpcProvider(RPC_URL);
  const wallet = new Wallet(PRIV_KEY, provider);

  console.log("from:", await wallet.getAddress());
  console.log("to:", TO);

  const balance = await provider.getBalance(await wallet.getAddress());
  console.log("balance:", balance.toString());

  const txReq = {
    to: TO,
    value: parseEther(VALUE),
    // Let ethers populate gas fields (EIP-1559 compatible)
  };

  const tx = await wallet.sendTransaction(txReq);
  console.log("tx hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("receipt status:", receipt.status);
  console.log("block:", receipt.blockNumber);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import fs from "node:fs/promises";
import { env } from "node:process";

let defaultBalance = env.GENESIS_BALANCE_default;
if (defaultBalance) {
  try {
    defaultBalance = "0x" + BigInt(defaultBalance).toString(16);
    console.log("default funding amount", defaultBalance);
  } catch {
    console.log("invalid amount", defaultBalance);
    process.exit(1);
  }
} else {
  defaultBalance = "0x0";
}

const genesisFile = await fs.readFile("/config/genesis.json");

const genesis = JSON.parse(genesisFile.toString());

// Optional gasLimit override for higher per-block capacity
if (env.GENESIS_GAS_LIMIT) {
  try {
    const hex = '0x' + BigInt(env.GENESIS_GAS_LIMIT).toString(16);
    genesis.gasLimit = hex;
    console.log('override gasLimit', hex);
  } catch {
    console.log('invalid GENESIS_GAS_LIMIT', env.GENESIS_GAS_LIMIT);
  }
}

const alloc = {};

for (const [address, value] of Object.entries(genesis.alloc || {})) {
  if (address.startsWith("0x")) {
    address = address.slice(2);
  }
  alloc[address.toLowerCase()] = value;
}

for (let addr of (env.GENESIS_ADDRESS || "").split(",")) {
  if (/^(0x)?[0-9a-fA-F]{40}$/.test(addr)) {
    if (addr.startsWith("0x")) {
      addr = addr.slice(2);
    }

    addr = addr.toLowerCase();

    const cur = alloc[addr] || {};
    cur.balance = defaultBalance;
    alloc[addr] = cur;
    console.log("address", addr, "default balance", cur.balance);
  }
}

for (const [envName, envValue] of Object.entries(env)) {
  if (!envName.startsWith("GENESIS")) {
    continue;
  }

  let [_, kind, address] = envName.split("_");
  if (!address || address === "default") {
    continue;
  }

  if (!/^(0x)?[0-9a-fA-F]{40}$/.test(address)) {
    continue;
  }

  kind = kind.toUpperCase();
  address = address.toLowerCase();

  if (address.startsWith("0x")) {
    address = address.slice(2);
  }

  const cur = alloc[address] || { balance: "0x0" };

  switch (kind) {
    case "BALANCE":
      const overwrited = !!cur.balance;
      try {
        cur.balance = "0x" + BigInt(envValue).toString(16);
      } catch {
        cur.balance = defaultBalance;
      }
      console.log(
        "address",
        address,
        "balance",
        cur.balance,
        "overwrited",
        overwrited
      );
      break;
    case "CODE":
      cur.code = envValue;
      console.log("address", address, "code", cur.code);
      break;
    case "NONCE":
      cur.nonce = envValue;
      try {
        cur.nonce = "0x" + BigInt(envValue).toString(16);
        console.log("address", address, "nonce", cur.nonce);
      } catch {
        console.log("invalid nonce", envValue, "for address", address);
      }
      break;
  }

  alloc[address] = cur;
}

if (Object.keys(alloc).length > Object.keys(genesis.alloc).length) {
  genesis.alloc = alloc;
}

await fs.writeFile("/geth/genesis.json", JSON.stringify(genesis, null, "  "));

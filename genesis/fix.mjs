import fs from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

const genesisFile = await fs.readFile("/geth/genesis.json");

const genesis = JSON.parse(genesisFile.toString());

genesis.config["blobSchedule"] = {
  cancun: {
    target: 3,
    max: 6,
    baseFeeUpdateFraction: 3338477,
  },
  prague: {
    target: 6,
    max: 9,
    baseFeeUpdateFraction: 5007716,
  },
};

await fs.writeFile("/geth/genesis.json", JSON.stringify(genesis, null, "  "));

await setTimeout(200);

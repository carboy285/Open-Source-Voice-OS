import { cpSync } from "node:fs";

cpSync("src/app/assets", "dist/app/assets", { recursive: true });

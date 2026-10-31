import "dotenv/config";
import { parseEnv } from "./parseEnv";

export const env = parseEnv(process.env);

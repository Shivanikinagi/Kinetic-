import { jsonReplacer } from "./crypto.js";

export type Logger = (message: string, fields?: Record<string, unknown>) => void;

export function logger(component: string): Logger {
  return (message, fields) => {
    const time = new Date().toISOString().slice(11, 23);
    const extra = fields ? " " + JSON.stringify(fields, jsonReplacer) : "";
    console.log(`${time} ${component.padEnd(12)} ${message}${extra}`);
  };
}

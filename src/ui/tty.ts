// src/ui/tty.ts
export function isTTY(stream: NodeJS.WriteStream = process.stdout): boolean {
  return Boolean(stream.isTTY);
}

export function noColor(): boolean {
  return Boolean(process.env.NO_COLOR ?? process.env.REOCLO_NO_COLOR);
}

import type { Channel } from "./types.ts";

export interface Registry {
  get(id: string): Channel | undefined;
  register(ch: Channel): void;
  ids(): string[];
}

export function createRegistry(): Registry {
  const map = new Map<string, Channel>();
  return {
    get: (id) => map.get(id),
    register: (ch) => {
      map.set(ch.id, ch);
    },
    ids: () => [...map.keys()],
  };
}

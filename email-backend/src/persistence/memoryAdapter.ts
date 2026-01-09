// Simple abstraction layer for persistence (in-memory default)
// Future: implement Redis or database adapters with same interface
export interface KeyValueStore {
  get<T=any>(key: string): Promise<T | undefined>;
  set<T=any>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  size?(): Promise<number>;
}

export class InMemoryKV implements KeyValueStore {
  private data = new Map<string,{ value:any; expires?: number }>();
  async get<T>(key: string){
    const e = this.data.get(key);
    if(!e) return undefined;
    if(e.expires && Date.now() > e.expires){
      this.data.delete(key);
      return undefined;
    }
    return e.value as T;
  }
  async set<T>(key: string, value: T, ttlSeconds?: number){
    const expires = ttlSeconds ? Date.now() + ttlSeconds*1000 : undefined;
    this.data.set(key,{ value, expires });
  }
  async delete(key: string){ this.data.delete(key); }
  async size(){ return this.data.size; }
}

export const defaultKV = new InMemoryKV();

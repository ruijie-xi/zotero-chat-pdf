declare const document: Document;
declare const crypto: Crypto;
declare function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): number;
declare function clearTimeout(handle?: number): void;

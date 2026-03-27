const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function randomId(length: number = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let result = "";

  for (const byte of bytes) {
    result += ALPHABET[byte % ALPHABET.length];
  }

  return result;
}

export function createUserId() {
  return `usr_${randomId(16)}`;
}

export function createNodeId() {
  return `nod_${randomId(16)}`;
}

export function createInsightId() {
  return `ins_${randomId(16)}`;
}

export function createApiKey() {
  return `kn_live_${randomId(32)}`;
}

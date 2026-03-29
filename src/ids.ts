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

export function createApiKeyId() {
  return `key_${randomId(16)}`;
}

export function createNodeId() {
  return `nod_${randomId(16)}`;
}

export function createInsightId() {
  return `ins_${randomId(16)}`;
}

export function createMessageId() {
  return `msg_${randomId(16)}`;
}

export function createApiKey() {
  return `kn_live_${randomId(32)}`;
}

export function createAccessGrantId() {
  return `agr_${randomId(16)}`;
}

export function createAccessToken() {
  return `kn_access_${randomId(32)}`;
}

export function createDeveloperId() {
  return `dev_${randomId(16)}`;
}

export function createDeveloperClientId() {
  return `kn_dev_${randomId(24)}`;
}

export function createDeveloperClientSecret() {
  return `kn_sec_${randomId(32)}`;
}

export function createLinkCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let code = "";

  for (const byte of bytes) {
    code += String(byte % 10);
  }

  return code;
}

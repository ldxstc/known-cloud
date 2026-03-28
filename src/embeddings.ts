import type { EnvBindings } from "./db";

// Cloudflare Workers AI embedding model (FREE)
// 768 dimensions, high quality, zero cost
const CF_EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    const chunk = bytes.subarray(index, index + 0x8000);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeEmbedding(vector: Float32Array): ArrayBuffer {
  const rawBytes = new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
  const base64 = bytesToBase64(rawBytes);
  const encoded = new TextEncoder().encode(base64);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}

export function decodeEmbedding(blob: ArrayBuffer | null): Float32Array | null {
  if (!blob) return null;
  const encoded = new Uint8Array(blob);
  const base64 = new TextDecoder().decode(encoded);
  const rawBytes = base64ToBytes(base64);
  const aligned = rawBytes.byteOffset === 0 && rawBytes.byteLength === rawBytes.buffer.byteLength
    ? rawBytes.buffer
    : rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength);
  return new Float32Array(aligned);
}

export async function generateEmbeddingVector(env: EnvBindings, text: string) {
  // Use Cloudflare Workers AI — free, no API key needed
  const response = await (env as any).AI.run(CF_EMBEDDING_MODEL, {
    text: [text],
  });
  return new Float32Array(response.data[0] ?? []);
}

export async function generateEmbeddingBlob(env: EnvBindings, text: string) {
  return encodeEmbedding(await generateEmbeddingVector(env, text));
}

export async function generateEmbeddingBlobs(env: EnvBindings, texts: string[]) {
  if (texts.length === 0) return [];

  // Batch embeddings via CF Workers AI
  const response = await (env as any).AI.run(CF_EMBEDDING_MODEL, {
    text: texts,
  });

  return (response.data as number[][]).map(
    (vec: number[]) => encodeEmbedding(new Float32Array(vec))
  );
}

export function cosineSimilarity(left: Float32Array, right: Float32Array) {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0, leftNorm = 0, rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator === 0 ? 0 : dot / denominator;
}

export function semanticSearch<T extends { embedding: ArrayBuffer | null }>(
  query: Float32Array,
  items: T[],
  limit: number = 20,
) {
  return items
    .map((item) => {
      const vector = decodeEmbedding(item.embedding);
      if (!vector || vector.length !== query.length) return null;
      return { ...item, score: cosineSimilarity(query, vector) };
    })
    .filter((item): item is T & { score: number } => item !== null)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

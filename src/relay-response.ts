/** Relay data is untrusted even when HTTPS authenticates the selected server. */
export async function relayJson(response: Response): Promise<Record<string, any>> {
  if (!response.ok) throw new Error(`Relay request failed (${response.status})`);
  if (!response.body) throw new Error("Empty relay response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) { await reader.cancel(); throw new Error("Relay response too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid relay response");
  return value as Record<string, any>;
}

export function registrationFields(value: Record<string, any>, v2: boolean) {
  const { sourceId, writerToken } = value;
  const id = v2 ? /^[A-Za-z0-9_-]{22}$/ : /^[A-Za-z0-9_-]{43}$/;
  if (typeof sourceId !== "string" || !id.test(sourceId) || typeof writerToken !== "string" ||
      !(v2 ? new RegExp(`^${sourceId}\\.[A-Za-z0-9_-]{43}$`) : /^[A-Za-z0-9_-]{43}$/).test(writerToken)) throw new Error("Invalid relay credentials");
  return { sourceId, writerToken };
}

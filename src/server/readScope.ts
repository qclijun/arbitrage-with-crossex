import { randomUUID } from 'node:crypto';

// An opaque per-client identity, never a key hash or masked credential.
const identities = new WeakMap<object, string>();
export function credentialIdentity(owner: object): string {
  let id = identities.get(owner);
  if (!id) { id = randomUUID(); identities.set(owner, id); }
  return id;
}
export function rotateCredentialIdentity(owner: object): void { identities.set(owner, randomUUID()); }

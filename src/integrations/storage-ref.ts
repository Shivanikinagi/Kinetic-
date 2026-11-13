// 0G Storage references, kept free of the 0G SDK so passport checks can use them anywhere.

/** A 0G Storage root: 0x and 64 hex. */
export const isStorageRef = (ref: string) => /^0x[0-9a-f]{64}$/i.test(ref);

/** A public HTTP link to a stored file, served by the 0G Storage indexer (GET /file?root=). */
export const storageUrl = (gateway: string, ref: string) => `${gateway.replace(/\/$/, "")}/file?root=${ref}`;

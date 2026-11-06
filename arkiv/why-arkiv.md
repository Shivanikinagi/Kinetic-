# Why Arkiv

## If this ran on Postgres instead

- **Someone has to own the database, and they can rewrite it.** In KINETIC no single party is trusted. If the marketplace operator ran Postgres, it could hide a cheaper provider's offer, edit reputation, or mark chunks done. On Arkiv, every offer is signed and owned by its provider, and every reputation record is owned by the verifier's wallet, so readers can check who wrote what.
- **Liveness would need a cleanup job.** Dead providers and abandoned claims would linger until some cron job removed them. Arkiv's expiry *is* the liveness signal: no renewal, no offer.
- **Other agents couldn't join without an API key.** Any buyer agent can query offers directly from the chain without asking the operator. A second dashboard or a competing buyer agent works the same way.

## What we keep off Arkiv, and why

- **Chunk data and results:** too large and private. They go to Swarm, AES-GCM encrypted with a key per chunk. Arkiv holds only *sealed* references.
- **Payments, bonds, slashing:** these need value transfer and finality. They live on Hedera (x402 settlements, the bond vault).
- **The audit log:** HCS gives an ordered, timestamped log that only the verifier's key can append to.
- **Keys:** never on any chain. Providers receive a single chunk's key only inside the paid HTTPS request.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Database } from "bun:sqlite";

export interface KeyScope {
  id: string;
  project: string;
  environment: string;
}

export interface CreatedKey extends KeyScope {
  secret: string;
  prefix: string;
  createdAt: string;
}

function hash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class KeyManager {
  constructor(private readonly db: Database) {}

  create(project: string, environment: string): CreatedKey {
    const secret = `lf_${randomBytes(32).toString("base64url")}`;
    const key: CreatedKey = {
      id: randomUUID(),
      secret,
      prefix: secret.slice(0, 11),
      project,
      environment,
      createdAt: new Date().toISOString(),
    };
    this.db.query(`INSERT INTO api_keys (id, key_hash, prefix, project, environment, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(key.id, hash(secret), key.prefix, project, environment, key.createdAt);
    return key;
  }

  authenticate(secret: string): KeyScope | null {
    if (!secret.startsWith("lf_") || secret.length > 128) return null;
    const row = this.db.query(`SELECT id, project, environment FROM api_keys
      WHERE key_hash = ? AND revoked_at IS NULL`).get(hash(secret)) as KeyScope | null;
    return row || null;
  }

  list(): Array<Omit<CreatedKey, "secret"> & { revokedAt: string | null }> {
    return this.db.query(`SELECT id, prefix, project, environment, created_at AS createdAt, revoked_at AS revokedAt
      FROM api_keys ORDER BY created_at DESC`).all() as Array<Omit<CreatedKey, "secret"> & { revokedAt: string | null }>;
  }

  revoke(id: string): boolean {
    const result = this.db.query(`UPDATE api_keys SET revoked_at = ?
      WHERE id = ? AND revoked_at IS NULL`).run(new Date().toISOString(), id);
    return result.changes > 0;
  }
}

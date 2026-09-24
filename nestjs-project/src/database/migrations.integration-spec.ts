import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1790116319623 } from './migrations/1790116319623-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';
import { Video } from '../videos/entities/video.entity';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1790116319623,
        ],
      },
    );

    await dataSource.initialize();

    // Sequential, not Promise.all: concurrent DDL (DROP TABLE/TYPE) against
    // overlapping objects (FKs, dependent types) is a real deadlock risk in
    // Postgres — confirmed empirically once a third enum type was added
    // here. DDL teardown has no throughput requirement, so there is nothing
    // to gain from parallelizing it.
    for (const table of MANAGED_TABLES) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    await dataSource.query(`DROP TABLE IF EXISTS "migrations" CASCADE`);
    // DROP TABLE ... CASCADE removes dependent constraints/views, but
    // never the custom enum TYPEs a dropped column used — a prior run
    // that crashed before completing its own teardown (or, historically,
    // a migration generated against a DB that already had these types as
    // residue from a discarded attempt) can leave them behind, silently
    // masking a migration that never actually creates them itself.
    // Dropping them here makes the suite self-healing AND proves each
    // migration is reproducible against a genuinely empty schema.
    await dataSource.query(
      `DROP TYPE IF EXISTS "verification_tokens_type_enum" CASCADE`,
    );
    await dataSource.query(
      `DROP TYPE IF EXISTS "videos_processing_status_enum" CASCADE`,
    );
    await dataSource.query(
      `DROP TYPE IF EXISTS "videos_publication_status_enum" CASCADE`,
    );
  });

  afterAll(async () => {
    // Later tests undo migrations one at a time, leaving tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all three migrations against an empty schema and create all five tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should revert the CreateVideos migration and remove the videos table and its enum types', async () => {
    await dataSource.undoLastMigration();

    const tableResult = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'videos'`,
    );
    expect(tableResult).toHaveLength(0);

    const typeResult = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type
       WHERE typname = ANY($1::text[])`,
      [['videos_processing_status_enum', 'videos_publication_status_enum']],
    );
    expect(typeResult).toHaveLength(0);
  });

  it('should revert the CreateAuthTokens migration and remove token tables', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['refresh_tokens', 'verification_tokens']],
    );
    expect(result).toHaveLength(0);
  });

  it('should re-apply CreateAuthTokens and CreateVideos cleanly (revert/reapply round-trip)', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations.map((m) => m.name)).toEqual([
      'CreateAuthTokens1777579850478',
      'CreateVideos1790116319623',
    ]);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    expect(result.map((r) => r.table_name)).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });
});

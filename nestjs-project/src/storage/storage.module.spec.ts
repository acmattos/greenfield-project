import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { INTERNAL_S3_CLIENT } from './storage.constants';

describe('StorageModule', () => {
  it('should compile and resolve INTERNAL_S3_CLIENT via DI', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    const client = module.get(INTERNAL_S3_CLIENT);
    expect(client).toBeDefined();

    await module.close();
  }, 15000);
});

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';

/**
 * File storage (SRS SI-3). Files are kept on disk under UPLOAD_DIR (default ./uploads). The rest of the code only uses
 * save / open / remove with a storage key, so a cloud store (S3, Google Cloud Storage) can replace this class later.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger('Storage');
  private readonly root: string;

  constructor(config: ConfigService) {
    this.root = resolve(config.get<string>('UPLOAD_DIR') ?? 'uploads');
  }

  /** Saves the bytes and returns their storage key: <workspaceId>/<random id>. */
  async save(workspaceId: string, data: Buffer) {
    const key = `${workspaceId}/${randomUUID()}`;
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { flag: 'wx' });
    return key;
  }

  /** Profile photos: avatars/<random id>.<png|jpg|webp>. Returns the file name used in the photo's address. */
  async saveAvatar(data: Buffer, ext: 'png' | 'jpg' | 'webp') {
    const name = `${randomUUID()}.${ext}`;
    const path = this.path(`avatars/${name}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { flag: 'wx' });
    return name;
  }

  open(key: string) {
    return createReadStream(this.path(key));
  }

  async remove(key: string) {
    try {
      await rm(this.path(key), { force: true });
    } catch (e) {
      this.logger.warn(`Could not delete ${key}: ${(e as Error).message}`);
    }
  }

  /** Keys are generated here, but the check keeps any key from reaching outside the upload folder. */
  private path(key: string) {
    if (!/^([0-9a-f-]{36}\/[0-9a-f-]{36}|avatars\/[0-9a-f-]{36}\.(png|jpg|webp))$/.test(key)) throw new Error('invalid storage key');
    return join(this.root, key);
  }
}

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export enum VideoProcessingStatus {
  UPLOADING = 'UPLOADING',
  PROCESSING = 'PROCESSING',
  READY = 'READY',
  FAILED = 'FAILED',
}

export enum VideoPublicationStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
}

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_videos_channel_id')
  @Column({ name: 'channel_id', type: 'uuid' })
  channelId: string;

  @ManyToOne(() => Channel, (channel) => channel.videos)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({
    name: 'processing_status',
    type: 'enum',
    enum: VideoProcessingStatus,
    default: VideoProcessingStatus.UPLOADING,
  })
  processingStatus: VideoProcessingStatus;

  @Column({
    name: 'publication_status',
    type: 'enum',
    enum: VideoPublicationStatus,
    default: VideoPublicationStatus.DRAFT,
  })
  publicationStatus: VideoPublicationStatus;

  @Column({ name: 'source_storage_key', type: 'varchar', length: 255 })
  sourceStorageKey: string;

  @Column({
    name: 'thumbnail_storage_key',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  thumbnailStorageKey: string | null;

  @Column({
    name: 'upload_completed_at',
    type: 'timestamptz',
    nullable: true,
  })
  uploadCompletedAt: Date | null;

  @Column({ name: 'duration_seconds', type: 'integer', nullable: true })
  durationSeconds: number | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({
    name: 'video_codec',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  videoCodec: string | null;

  @Column({
    name: 'audio_codec',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  audioCodec: string | null;

  @Column({ name: 'bit_rate', type: 'integer', nullable: true })
  bitRate: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

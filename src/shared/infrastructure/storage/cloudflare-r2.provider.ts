import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CloudflareR2Provider implements OnModuleInit {
    private s3!: S3Client;
    private bucketName!: string;

    constructor(private configService: ConfigService) {

    }

    onModuleInit() {
        const endpoint = this.configService.get<string>('R2_ENDPOINT');
        const accesskeyId = this.configService.get<string>('R2_ACCESS_KEY_ID');
        const secretAccessKey = this.configService.get<string>('R2_SECRET_ACCESS_KEY');
        const bucket = this.configService.get<string>('R2_BUCKET_NAME');

        if (!endpoint || !accesskeyId || !secretAccessKey || !bucket) {
            throw new Error('Missing Cloudflare R2 configuration in .env.development');
        }

        this.s3 = new S3Client({
            region: "auto",
            endpoint: endpoint,
            credentials: {
                accessKeyId: accesskeyId,
                secretAccessKey: secretAccessKey,
            },
        });

        this.bucketName = bucket;
        console.log('Cloudflare R2 Storage Provider initialized');
    }

    /**
     * Generates a signed URL for the HLS Master Playlist.
     * Uses the Package-per-Film structure defined in architecture.
     */
    async getPresignedManifestUrl(movieId: string): Promise<string> {
        const command = new GetObjectCommand({
            Bucket: this.bucketName,
            Key: `film/${movieId}/master.m3u8`,     // Logical pathing
        });

        return getSignedUrl(this.s3, command, { expiresIn: 14400 });
    }
}
